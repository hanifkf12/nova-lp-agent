import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction,
  sendAndConfirmTransaction, SimulatedTransactionResponse,
} from '@solana/web3.js';
import DLMM, { StrategyType, getPriceOfBinByBinId } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import bs58 from 'bs58';
import { config } from '../config';
import { logger } from '../utils/logger';
import { db, getState, setState, getOpenPositions, markPositionOrphan } from '../db';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let _wallet: Keypair | null = null;

// ── RPC connection with fallback rotation ──────────────────────

const rpcEndpoints = [config.rpcUrl, ...config.rpcFallbacks].filter(Boolean);
let rpcIdx = 0;
let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) _connection = newConnection(rpcEndpoints[rpcIdx]);
  return _connection;
}

function newConnection(url: string): Connection {
  return new Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });
}

export function rotateRpc(): Connection {
  if (rpcEndpoints.length <= 1) return getConnection();
  rpcIdx = (rpcIdx + 1) % rpcEndpoints.length;
  _connection = newConnection(rpcEndpoints[rpcIdx]);
  dlmmCache.clear();
  logger.warn('Rotated RPC endpoint', { endpoint: rpcEndpoints[rpcIdx] });
  return _connection;
}

export function getWallet(): Keypair {
  if (!_wallet) {
    _wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
  }
  return _wallet;
}

export async function getSolBalance(): Promise<number> {
  if (config.dryRun) return config.totalCapitalSol;
  const conn   = getConnection();
  const wallet = getWallet();
  const bal    = await conn.getBalance(wallet.publicKey);
  return bal / 1e9;
}

// ── Transaction simulation ─────────────────────────────────────

async function simulate(conn: Connection, tx: Transaction): Promise<SimulatedTransactionResponse> {
  const { value } = await conn.simulateTransaction(tx);
  if (value.err) {
    throw new Error(`Tx simulation failed: ${JSON.stringify(value.err)} | logs: ${(value.logs ?? []).slice(-5).join(' | ')}`);
  }
  logger.debug('Tx simulation OK', { units: value.unitsConsumed ?? 'N/A' });
  return value;
}

async function sendTxs(
  conn:    Connection,
  txs:     (Transaction | VersionedTransaction)[],
  signers: Keypair[],
): Promise<string[]> {
  const sigs: string[] = [];
  for (const tx of txs) {
    if (tx instanceof VersionedTransaction) {
      tx.sign(signers);
      const sig = await conn.sendTransaction(tx);
      await conn.confirmTransaction(sig, 'confirmed');
      sigs.push(sig);
    } else {
      await simulate(conn, tx);
      const sig = await sendAndConfirmTransaction(conn, tx, signers);
      sigs.push(sig);
    }
  }
  return sigs;
}

// ── DLMM instance cache ────────────────────────────────────────

const dlmmCache = new Map<string, DLMM>();

async function getDLMM(conn: Connection, poolPubkey: PublicKey): Promise<DLMM> {
  const key = poolPubkey.toString();
  if (!dlmmCache.has(key)) {
    dlmmCache.set(key, await DLMM.create(conn, poolPubkey));
  }
  return dlmmCache.get(key)!;
}

// Read-only on-chain lookup for a pool's current price, active bin, bin step.
// Used by dry-mode code paths since no HTTP endpoint reliably fetches a single pool.
async function getDLMMReadOnly(poolAddress: string): Promise<{
  currentPrice: number;
  activeBinId:  number;
  binStep:      number;
} | null> {
  const attempt = async () => {
    const conn       = getConnection();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await getDLMM(conn, poolPubkey);
    const activeBin  = await dlmmPool.getActiveBin();
    const activeBinId = Number(activeBin.binId);
    const currentPrice = Number(dlmmPool.fromPricePerLamport(Number(activeBin.price)));
    const binStep = Number((dlmmPool as any).lbPair?.binStep ?? 0);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || binStep <= 0) return null;
    return { currentPrice, activeBinId, binStep };
  };

  try {
    return await attempt();
  } catch (err) {
    logger.warn('getDLMMReadOnly failed, rotating RPC', { poolAddress, err: (err as Error).message });
    rotateRpc();
    try {
      return await attempt();
    } catch (err2) {
      logger.warn('getDLMMReadOnly retry failed', { poolAddress, err: (err2 as Error).message });
      return null;
    }
  }
}

// ── Pool token-side identification ─────────────────────────────

interface PoolSides {
  solIsX:    boolean;
  decimalsX: number;
  decimalsY: number;
}

function getPoolSides(dlmmPool: DLMM): PoolSides {
  const xMint = (dlmmPool as any).tokenX?.publicKey?.toString?.()
             ?? (dlmmPool as any).lbPair?.tokenXMint?.toString?.();
  const yMint = (dlmmPool as any).tokenY?.publicKey?.toString?.()
             ?? (dlmmPool as any).lbPair?.tokenYMint?.toString?.();

  const decimalsX = (dlmmPool as any).tokenX?.decimal ?? (dlmmPool as any).tokenX?.mint?.decimals ?? 9;
  const decimalsY = (dlmmPool as any).tokenY?.decimal ?? (dlmmPool as any).tokenY?.mint?.decimals ?? 9;

  const solIsX = xMint === SOL_MINT;
  const solIsY = yMint === SOL_MINT;

  if (!solIsX && !solIsY) {
    throw new Error(`Pool has no SOL side: X=${xMint} Y=${yMint}`);
  }

  return { solIsX, decimalsX, decimalsY };
}

// ── Strategy mapping ───────────────────────────────────────────

function toStrategyType(s: string): StrategyType {
  switch (s) {
    case 'curve':   return StrategyType.Curve;
    case 'bid_ask': return StrategyType.BidAsk;
    default:        return StrategyType.Spot;
  }
}

// ── Deploy LP position (single-sided SOL) ──────────────────────

export interface DeployResult {
  success:        boolean;
  positionPubkey?: string;
  txSignature?:   string;
  entryPrice?:    number;
  priceRangeMin?: number;
  priceRangeMax?: number;
  binCount?:      number;
  error?:         string;
}

export async function deployPosition(
  poolAddress: string,
  strategy:    string,
  solAmount:   number,
  binRange:    number = config.binRange,
): Promise<DeployResult> {

  if (config.dryRun) {
    const onchain = await getDLMMReadOnly(poolAddress);
    if (!onchain) {
      logger.warn('[DRY RUN] deployPosition: on-chain read failed, skipping deploy', { poolAddress });
      return { success: false, error: 'on-chain read failed' };
    }
    const { currentPrice: entryPrice, binStep } = onchain;
    // Assume single-sided SOL = Y (SOL is quote, bins below active). Most memecoin/SOL pools.
    // Range: [entryPrice / (1+binStep/10000)^(binRange-1), entryPrice]
    const factor = Math.pow(1 + binStep / 10000, binRange - 1);
    const priceRangeMin = entryPrice / factor;
    const priceRangeMax = entryPrice;
    logger.info('[DRY RUN] Would deploy position', {
      poolAddress, strategy, solAmount, binRange, binStep,
      entryPrice, priceRangeMin, priceRangeMax,
    });
    return {
      success:        true,
      positionPubkey: `dry_${Date.now()}`,
      txSignature:    `dry_tx_${Date.now()}`,
      entryPrice,
      priceRangeMin,
      priceRangeMax,
      binCount:       binRange,
    };
  }

  try {
    const conn       = getConnection();
    const wallet     = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await getDLMM(conn, poolPubkey);
    const sides      = getPoolSides(dlmmPool);

    const activeBin     = await dlmmPool.getActiveBin();
    const entryPriceStr = dlmmPool.fromPricePerLamport(Number(activeBin.price));
    const entryPriceNum = Number(entryPriceStr);
    const activeBinId   = Number(activeBin.binId);

    // Single-sided SOL deposit:
    //  - If SOL is Y → bins below + at active (bins hold Y when current price ≥ bin price)
    //  - If SOL is X → bins above + at active
    let minBinId: number, maxBinId: number;
    if (sides.solIsX) {
      minBinId = activeBinId;
      maxBinId = activeBinId + (binRange - 1);
    } else {
      minBinId = activeBinId - (binRange - 1);
      maxBinId = activeBinId;
    }

    const solLamports = new BN(Math.floor(solAmount * 1e9));
    const totalXAmount = sides.solIsX ? solLamports : new BN(0);
    const totalYAmount = sides.solIsX ? new BN(0) : solLamports;

    const newPosition = Keypair.generate();
    const createRaw = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user:           wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        maxBinId,
        minBinId,
        strategyType: toStrategyType(strategy),
      },
      slippage: config.slippageBps / 100,
    });

    const txs = Array.isArray(createRaw) ? createRaw : [createRaw];
    const sigs = await sendTxs(conn, txs, [wallet, newPosition]);

    // Compute actual price-range from chosen bin ids using the SDK helper
    const binStep = Number((dlmmPool as any).lbPair?.binStep ?? 0);
    const priceAtBin = (binId: number): number => {
      const raw = Number(getPriceOfBinByBinId(binId, binStep));
      return Number(dlmmPool.fromPricePerLamport(raw));
    };
    const priceRangeMin = priceAtBin(minBinId);
    const priceRangeMax = priceAtBin(maxBinId);

    logger.info('Position deployed', {
      poolAddress,
      positionPubkey: newPosition.publicKey.toString(),
      sigs,
      side:           sides.solIsX ? 'X=SOL' : 'Y=SOL',
      minBinId, maxBinId,
    });

    return {
      success:        true,
      positionPubkey: newPosition.publicKey.toString(),
      txSignature:    sigs[0],
      entryPrice:     entryPriceNum,
      priceRangeMin,
      priceRangeMax,
      binCount:       maxBinId - minBinId + 1,
    };

  } catch (err) {
    logger.error('Deploy position failed', { err });
    return { success: false, error: (err as Error).message };
  }
}

// ── Fee accounting ─────────────────────────────────────────────

function feesToSol(feeXRaw: number, feeYRaw: number, sides: PoolSides, pricePerXInY: number): number {
  const feeXTokens = feeXRaw / Math.pow(10, sides.decimalsX);
  const feeYTokens = feeYRaw / Math.pow(10, sides.decimalsY);
  if (sides.solIsX) {
    // X is SOL. Convert feeY (in token Y) to SOL via 1 X = pricePerXInY Y → 1 Y = 1/pricePerXInY X
    const feeYInSol = pricePerXInY > 0 ? feeYTokens / pricePerXInY : 0;
    return feeXTokens + feeYInSol;
  } else {
    // Y is SOL. 1 X = pricePerXInY Y(=SOL)
    const feeXInSol = feeXTokens * pricePerXInY;
    return feeXInSol + feeYTokens;
  }
}

// ── Claim fees ─────────────────────────────────────────────────

export async function claimFees(
  poolAddress:    string,
  positionPubkey: string,
): Promise<{ success: boolean; feesClaimedSol: number; error?: string }> {

  if (config.dryRun) {
    const pos = db.prepare(
      `SELECT id FROM positions WHERE position_pubkey = ? AND status = 'open'`
    ).get(positionPubkey) as any;
    if (!pos) {
      logger.warn('[DRY RUN] claimFees: no open position', { positionPubkey });
      return { success: true, feesClaimedSol: 0 };
    }
    const stateKey = `dry_pos:${pos.id}`;
    const raw = getState(stateKey);
    const s = raw ? JSON.parse(raw) : { pendingFees: 0 };
    const claimed = s.pendingFees ?? 0;
    s.pendingFees = 0;
    setState(stateKey, JSON.stringify(s));
    logger.info('[DRY RUN] Would claim fees', { feesClaimedSol: claimed });
    return { success: true, feesClaimedSol: claimed };
  }

  try {
    const conn       = getConnection();
    const wallet     = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await getDLMM(conn, poolPubkey);
    const sides      = getPoolSides(dlmmPool);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const position = userPositions.find(p => p.publicKey.toString() === positionPubkey);
    if (!position) return { success: false, feesClaimedSol: 0, error: 'Position not found' };

    const feeXRaw = Number(position.positionData.feeX);
    const feeYRaw = Number(position.positionData.feeY);

    const activeBin    = await dlmmPool.getActiveBin();
    const pricePerXInY = Number(dlmmPool.fromPricePerLamport(Number(activeBin.price)));

    const claimRaw = await dlmmPool.claimAllRewards({
      owner:    wallet.publicKey,
      positions: [position],
    });
    const txs = Array.isArray(claimRaw) ? claimRaw : [claimRaw];
    await sendTxs(conn, txs, [wallet]);

    const feesClaimedSol = feesToSol(feeXRaw, feeYRaw, sides, pricePerXInY);
    logger.info('Fees claimed', { feesClaimedSol });
    return { success: true, feesClaimedSol };

  } catch (err) {
    logger.error('Claim fees failed', { err });
    return { success: false, feesClaimedSol: 0, error: (err as Error).message };
  }
}

// ── Close position ─────────────────────────────────────────────

export async function closePosition(
  poolAddress:    string,
  positionPubkey: string,
): Promise<{ success: boolean; feesClaimedSol: number; exitPrice: number; error?: string }> {

  if (config.dryRun) {
    const pos = db.prepare(
      `SELECT id FROM positions WHERE position_pubkey = ? AND status = 'open'`
    ).get(positionPubkey) as any;
    const onchain = await getDLMMReadOnly(poolAddress);
    const exitPrice = onchain?.currentPrice ?? 0;
    if (!pos) {
      logger.warn('[DRY RUN] closePosition: no open position', { positionPubkey });
      return { success: true, feesClaimedSol: 0, exitPrice };
    }
    const stateKey = `dry_pos:${pos.id}`;
    const raw = getState(stateKey);
    const s = raw ? JSON.parse(raw) : { pendingFees: 0 };
    const finalFees = s.pendingFees ?? 0;
    db.prepare('DELETE FROM agent_state WHERE key = ?').run(stateKey);
    logger.info('[DRY RUN] Would close position', { feesClaimedSol: finalFees, exitPrice });
    return { success: true, feesClaimedSol: finalFees, exitPrice };
  }

  try {
    const conn       = getConnection();
    const wallet     = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await getDLMM(conn, poolPubkey);
    const sides      = getPoolSides(dlmmPool);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const position = userPositions.find(p => p.publicKey.toString() === positionPubkey);
    if (!position) return { success: false, feesClaimedSol: 0, exitPrice: 0, error: 'Position not found' };

    const feeXRaw = Number(position.positionData.feeX);
    const feeYRaw = Number(position.positionData.feeY);

    const activeBin    = await dlmmPool.getActiveBin();
    const pricePerXInY = Number(dlmmPool.fromPricePerLamport(Number(activeBin.price)));

    const binIds   = position.positionData.positionBinData.map((b: any) => b.binId);
    const fromBin  = Math.min(...binIds);
    const toBin    = Math.max(...binIds);

    const removeRaw = await dlmmPool.removeLiquidity({
      position: new PublicKey(positionPubkey),
      user:     wallet.publicKey,
      fromBinId: fromBin,
      toBinId:   toBin,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    });
    const txs = Array.isArray(removeRaw) ? removeRaw : [removeRaw];
    await sendTxs(conn, txs, [wallet]);

    const feesClaimedSol = feesToSol(feeXRaw, feeYRaw, sides, pricePerXInY);
    logger.info('Position closed', { poolAddress, positionPubkey, feesClaimedSol });
    return { success: true, feesClaimedSol, exitPrice: pricePerXInY };

  } catch (err) {
    logger.error('Close position failed', { err });
    return { success: false, feesClaimedSol: 0, exitPrice: 0, error: (err as Error).message };
  }
}

// ── Get live position data ─────────────────────────────────────

export interface LivePositionData {
  isInRange:      boolean;
  currentPrice:   number;       // pool quote price (Y per X), human units
  feesEarnedSol:  number;       // unclaimed fees valued in SOL
  positionValueSol: number;     // current liquidity value in SOL
  ilSol:          number;       // realized IL in SOL terms
  currentTvl:     number;
  currentVolume:  number;
  feeTvlRatio:    number;
}

export async function getLivePositionData(
  poolAddress:    string,
  positionPubkey: string,
  entryPrice:     number,
  solDeployed:    number,
): Promise<LivePositionData | null> {

  if (config.dryRun) {
    const pos = db.prepare(
      `SELECT id, opened_at, price_range_min, price_range_max,
              tvl_usd, volume_24h_usd, fee_tvl_ratio
       FROM positions WHERE position_pubkey = ? AND status = 'open'`
    ).get(positionPubkey) as any;
    if (!pos) {
      logger.warn('[DRY RUN] getLivePositionData: no open position', { positionPubkey });
      return null;
    }
    const onchain = await getDLMMReadOnly(poolAddress);
    if (!onchain) {
      logger.warn('[DRY RUN] getLivePositionData: on-chain price unavailable', { poolAddress });
      return null;
    }

    const currentPrice  = onchain.currentPrice;
    const priceRangeMin = pos.price_range_min ?? entryPrice * 0.95;
    const priceRangeMax = pos.price_range_max ?? entryPrice * 1.05;
    const midRange      = (priceRangeMin + priceRangeMax) / 2;
    const isInRange     = currentPrice >= priceRangeMin && currentPrice <= priceRangeMax;
    // Entry near top of range → SOL bins below active (solIsY); else above (solIsX).
    const solBelow      = entryPrice >= midRange;

    let positionValueSol: number;
    if (isInRange) {
      // Mild rebalance loss while in range (Uniswap-v2 IL formula as approximation)
      const r  = entryPrice > 0 ? currentPrice / entryPrice : 1;
      const il = r > 0 ? 2 * Math.sqrt(r) / (1 + r) - 1 : 0;   // ≤ 0
      positionValueSol = solDeployed * (1 + il);
    } else if (solBelow && currentPrice < priceRangeMin) {
      // Price fell through SOL bins → all SOL converted to token at avg midRange
      positionValueSol = solDeployed * (currentPrice / midRange);
    } else if (!solBelow && currentPrice > priceRangeMax) {
      // Price rose through SOL bins → all SOL converted to token at avg midRange
      positionValueSol = solDeployed * (currentPrice / midRange);
    } else {
      // Out-of-range on the side that wasn't touched → SOL untouched, no IL, no fees
      positionValueSol = solDeployed;
    }
    const ilSol = Math.max(0, solDeployed - positionValueSol);

    // Stored snapshot (entry-time) for pool health — discovery API has no per-pool fetch.
    const snapTvl    = pos.tvl_usd ?? 0;
    const snapVolume = pos.volume_24h_usd ?? 0;
    const snapFeeTvl = pos.fee_tvl_ratio ?? 0;

    // Incremental fee accrual via persisted state
    const stateKey = `dry_pos:${pos.id}`;
    const rawState = getState(stateKey);
    const state    = rawState
      ? JSON.parse(rawState)
      : { lastTickAt: pos.opened_at, pendingFees: 0 };
    const now      = Date.now();
    const deltaSec = Math.max(0, (now - state.lastTickAt) / 1000);
    if (isInRange && snapFeeTvl > 0) {
      // fee_tvl_ratio from discovery API is percent (e.g., 8.09 = 8.09%/day).
      // Convert to fraction and clamp to a sane daily ceiling.
      const dailyYield = Math.min(snapFeeTvl / 100, 0.5);
      state.pendingFees += solDeployed * dailyYield * (deltaSec / 86400);
    }
    state.lastTickAt = now;
    setState(stateKey, JSON.stringify(state));

    return {
      isInRange,
      currentPrice,
      feesEarnedSol:    state.pendingFees,
      positionValueSol,
      ilSol,
      currentTvl:       snapTvl,
      currentVolume:    snapVolume,
      feeTvlRatio:      snapFeeTvl,
    };
  }

  try {
    const conn       = getConnection();
    const wallet     = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await getDLMM(conn, poolPubkey);
    const sides      = getPoolSides(dlmmPool);

    const activeBin    = await dlmmPool.getActiveBin();
    const activeBinId  = Number(activeBin.binId);
    const currentPrice = Number(dlmmPool.fromPricePerLamport(Number(activeBin.price)));

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const position = userPositions.find(p => p.publicKey.toString() === positionPubkey);
    if (!position) return null;

    const posData    = position.positionData;
    const binIds     = posData.positionBinData.map((b: any) => b.binId);
    const minBinId   = Math.min(...binIds);
    const maxBinId   = Math.max(...binIds);
    const isInRange  = activeBinId >= minBinId && activeBinId <= maxBinId;

    const feesEarnedSol = feesToSol(
      Number(posData.feeX), Number(posData.feeY), sides, currentPrice,
    );

    // Position value: sum bins → (amountX in SOL) + (amountY in SOL)
    let posXRaw = 0, posYRaw = 0;
    for (const b of posData.positionBinData) {
      posXRaw += Number(b.positionXAmount ?? 0);
      posYRaw += Number(b.positionYAmount ?? 0);
    }
    const xTokens = posXRaw / Math.pow(10, sides.decimalsX);
    const yTokens = posYRaw / Math.pow(10, sides.decimalsY);
    const positionValueSol = sides.solIsX
      ? xTokens + (currentPrice > 0 ? yTokens / currentPrice : 0)
      : yTokens + xTokens * currentPrice;

    // IL: difference between current value and hypothetical "held SOL"
    const ilSol = Math.max(0, solDeployed - positionValueSol - feesEarnedSol);

    // Entry-time snapshot for pool health. Meteora's discovery API does not
    // support per-pool lookup (filter is silently ignored), so we surface the
    // values screening already vetted. They drift over a position's lifetime
    // but stay correctly attributed to THIS pool.
    const snap = db.prepare(
      `SELECT tvl_usd, volume_24h_usd, fee_tvl_ratio
       FROM positions WHERE position_pubkey = ? AND status = 'open'`
    ).get(positionPubkey) as any;

    return {
      isInRange,
      currentPrice,
      feesEarnedSol,
      positionValueSol,
      ilSol,
      currentTvl:     snap?.tvl_usd        ?? 0,
      currentVolume:  snap?.volume_24h_usd ?? 0,
      feeTvlRatio:    snap?.fee_tvl_ratio  ?? 0,
    };
  } catch (err) {
    logger.warn('getLivePositionData failed', { err });
    return null;
  }
}

// ── Startup reconciliation ─────────────────────────────────────
//
// Boot-time check that every DB row with status='open' actually corresponds to
// a live position on-chain. Catches drift from crashes during close, RPC errors
// mid-tx, or manual DB edits. Orphans are removed from the open set so the
// healer cycle won't try to operate on a ghost. Dry mode has nothing on-chain
// to verify so this is a no-op there.

export async function reconcileOpenPositions(): Promise<{
  checked: number;
  orphans: { id: number; symbol: string; reason: string }[];
}> {
  const open = getOpenPositions();
  if (open.length === 0) return { checked: 0, orphans: [] };

  if (config.dryRun) {
    logger.info('Reconciliation skipped (dry mode — nothing on-chain to verify)', { open: open.length });
    return { checked: open.length, orphans: [] };
  }

  const conn   = getConnection();
  const wallet = getWallet();
  const orphans: { id: number; symbol: string; reason: string }[] = [];

  // Group by pool to make one on-chain call per pool, not per position.
  const byPool = new Map<string, any[]>();
  for (const p of open) {
    if (!byPool.has(p.pool_address)) byPool.set(p.pool_address, []);
    byPool.get(p.pool_address)!.push(p);
  }

  for (const [poolAddress, rows] of byPool) {
    let onchainKeys = new Set<string>();
    try {
      const dlmmPool = await getDLMM(conn, new PublicKey(poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      onchainKeys = new Set(userPositions.map(p => p.publicKey.toString()));
    } catch (err) {
      logger.warn('Reconciliation: RPC failed for pool, skipping its positions', {
        poolAddress, err: (err as Error).message,
      });
      continue;
    }
    for (const row of rows) {
      const pk = row.position_pubkey ?? '';
      if (!pk || !onchainKeys.has(pk)) {
        markPositionOrphan(row.id, !pk ? 'missing pubkey' : 'not on-chain');
        orphans.push({ id: row.id, symbol: row.token_symbol, reason: !pk ? 'missing pubkey' : 'not on-chain' });
      }
    }
  }

  return { checked: open.length, orphans };
}


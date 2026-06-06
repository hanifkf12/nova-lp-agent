import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction,
  sendAndConfirmTransaction, SimulatedTransactionResponse,
} from '@solana/web3.js';
import DLMM, { StrategyType, getPriceOfBinByBinId } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import bs58 from 'bs58';
import Decimal from 'decimal.js';
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

// ── Safe price from lamports (handles large BN values) ─────────

// Accepts BN, Decimal, decimal string, or number — SDK returns mixed forms.
// BN cannot parse decimals/scientific notation, so callers must NOT wrap
// SDK-provided price strings in `new BN(...)`; pass the raw value here.
function safePriceFromLamport(
  dlmmPool: DLMM,
  lamportPrice: BN | Decimal | string | number,
): number {
  const priceStr = typeof lamportPrice === 'number'
    ? String(lamportPrice)
    : lamportPrice.toString();

  try {
    const d = dlmmPool.fromPricePerLamport(Number(priceStr));
    const n = Number(d);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* fall through */ }

  // Fallback: scale by token decimals
  const xDec = (dlmmPool as any).tokenX?.decimal ?? (dlmmPool as any).tokenX?.mint?.decimals ?? 9;
  const yDec = (dlmmPool as any).tokenY?.decimal ?? (dlmmPool as any).tokenY?.mint?.decimals ?? 9;
  try {
    const raw = new Decimal(priceStr);
    const scaled = raw.mul(Decimal.pow(10, yDec)).div(Decimal.pow(10, xDec));
    const n = Number(scaled);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* fall through */ }
  return 0;
}

function priceAtBinId(dlmmPool: DLMM, binId: number, binStep: number): number {
  const raw = getPriceOfBinByBinId(binId, binStep);
  return safePriceFromLamport(dlmmPool, raw as any);
}

// Read-only on-chain lookup for a pool's current price, active bin, bin step.
async function getDLMMReadOnly(poolAddress: string): Promise<{
  currentPrice: number;
  activeBinId:  number;
  binStep:      number;
} | null> {
  const attemptWith = async (conn: Connection) => {
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await getDLMM(conn, poolPubkey);
    const activeBin  = await dlmmPool.getActiveBin();
    const activeBinId = Number(activeBin.binId);
    const currentPrice = safePriceFromLamport(dlmmPool, activeBin.price);
    const binStep = Number((dlmmPool as any).lbPair?.binStep ?? 0);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || binStep <= 0) return null;
    return { currentPrice, activeBinId, binStep };
  };

  // Try current RPC first, then exhaust all fallbacks
  const tried = new Set<number>();
  for (let i = 0; i < rpcEndpoints.length; i++) {
    if (tried.has(rpcIdx)) break;
    tried.add(rpcIdx);
    try {
      return await attemptWith(getConnection());
    } catch (err) {
      const msg = (err as Error).message.slice(0, 80);
      if (i < rpcEndpoints.length - 1) {
        logger.warn('getDLMMReadOnly RPC failed, rotating', { poolAddress, err: msg });
        rotateRpc();
      } else {
        logger.warn('getDLMMReadOnly all RPCs exhausted', { poolAddress, err: msg });
      }
    }
  }

  return null;
}

// ── Live pool health via on-chain SDK ──────────────────────────

export async function getLivePoolHealth(poolAddress: string): Promise<{
  currentTvl: number;
  currentFeeRate: number;
  binStep: number;
} | null> {
  try {
    const conn       = getConnection();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await getDLMM(conn, poolPubkey);
    const lbPair     = (dlmmPool as any).lbPair;
    if (!lbPair) return null;

    const binStep    = Number(lbPair.binStep ?? 100);
    const decimalsX  = (dlmmPool as any).tokenX?.decimal ?? (dlmmPool as any).tokenX?.mint?.decimals ?? 9;
    const decimalsY  = (dlmmPool as any).tokenY?.decimal ?? (dlmmPool as any).tokenY?.mint?.decimals ?? 9;

    // SDK 1.9+ — supported API for ±N bins around the active bin.
    // Replaces a manual loop that poked SDK internals via `as any`.
    const { bins, activeBin: activeBinId } = await dlmmPool.getBinsAroundActiveBin(200, 200);

    const activeBin    = bins.find(b => b.binId === activeBinId);
    const currentPrice = activeBin ? safePriceFromLamport(dlmmPool, activeBin.price) : 0;

    let dynamicFee = 0;
    try {
      const feeData = await dlmmPool.getDynamicFee();
      dynamicFee = Number(feeData?.toString() ?? 0);
    } catch {
      dynamicFee = 0;
    }

    let totalX = new BN(0), totalY = new BN(0);
    for (const bin of bins) {
      totalX = totalX.add(bin.xAmount);
      totalY = totalY.add(bin.yAmount);
    }

    const xTokens = Number(new Decimal(totalX.toString()).div(Decimal.pow(10, decimalsX)));
    const yTokens = Number(new Decimal(totalY.toString()).div(Decimal.pow(10, decimalsY)));

    const solIsX = (dlmmPool as any).tokenX?.publicKey?.toString?.() === SOL_MINT
                || (dlmmPool as any).lbPair?.tokenXMint?.toString?.() === SOL_MINT;
    const currentTvl = solIsX
      ? xTokens + (currentPrice > 0 ? yTokens / currentPrice : 0)
      : yTokens + xTokens * currentPrice;

    return { currentTvl, currentFeeRate: dynamicFee, binStep };
  } catch (err) {
    logger.warn('getLivePoolHealth failed', { poolAddress, err: (err as Error).message });
    return null;
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
  rentSol?:       number;   // exact rent paid for position + bin arrays (live mode)
  error?:         string;
}

export async function deployPosition(
  poolAddress: string,
  strategy:    string,
  solAmount:   number,
  binRange:    number = config.binRange,
  knownPrice?: number,
  knownBinStep?: number,
): Promise<DeployResult> {

  if (config.dryRun) {
    const bs   = knownBinStep ?? 100;
    let entryPrice = knownPrice ?? 0;

    // Try on-chain for better price; fall back to known price from API
    if (!entryPrice || entryPrice <= 0) {
      const onchain = await getDLMMReadOnly(poolAddress);
      if (onchain && onchain.currentPrice > 0) {
        entryPrice = onchain.currentPrice;
      }
    }

    if (!entryPrice || entryPrice <= 0 || !Number.isFinite(entryPrice)) {
      logger.warn('[DRY RUN] deployPosition: no valid price available, skipping', { poolAddress });
      return { success: false, error: 'no valid price' };
    }

    const binStep = knownBinStep ?? bs;
    const factor = Math.pow(1 + binStep / 10000, binRange - 1);
    const priceRangeMin = entryPrice / factor;
    const priceRangeMax = entryPrice * factor;
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
    const entryPriceNum = safePriceFromLamport(dlmmPool, activeBin.price);
    const activeBinId   = Number(activeBin.binId);

    // Pre-deploy liquidity check — skip thin pools
    const { bins: binsAround } = await dlmmPool.getBinsAroundActiveBin(binRange, binRange);
    const totalBinLiquidity = binsAround.reduce(
      (sum: number, b: any) => sum + Number(b.xAmount ?? 0) + Number(b.yAmount ?? 0), 0
    );
    const liquiditySol = totalBinLiquidity / 1e9;
    if (liquiditySol < solAmount * 5) {
      return { success: false, error: `Pool liquidity ${liquiditySol.toFixed(2)} SOL too thin for ${solAmount} SOL deploy` };
    }

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

    const strategyParams = {
      maxBinId,
      minBinId,
      strategyType: toStrategyType(strategy),
    };

    // Exact rent quote — replaces the old hardcoded 0.005 SOL guess.
    // Returns lamports for position account + bin array(s) + bitmap extension.
    let rentSol = 0;
    try {
      const q = await dlmmPool.quoteCreatePosition({ strategy: strategyParams });
      rentSol = (q.positionCost + q.positionReallocCost + q.bitmapExtensionCost + q.binArrayCost) / 1e9;
      const balanceLamports = await conn.getBalance(wallet.publicKey);
      const required = solLamports.toNumber() + rentSol * 1e9 + 5_000_000; // +0.005 SOL fee buffer
      if (balanceLamports < required) {
        return {
          success: false,
          error: `Insufficient SOL: have ${(balanceLamports / 1e9).toFixed(4)}, need ${(required / 1e9).toFixed(4)} (deploy ${solAmount} + rent ${rentSol.toFixed(4)} + fee buffer)`,
        };
      }
      logger.info('Position rent quoted', {
        rentSol: rentSol.toFixed(6),
        binArrays: q.binArraysCount,
        positionCount: q.positionCount,
        txCount: q.transactionCount,
      });
    } catch (err) {
      logger.warn('quoteCreatePosition failed, proceeding with conservative estimate', {
        err: (err as Error).message,
      });
      rentSol = 0.06; // conservative fallback if quote API fails
    }

    const newPosition = Keypair.generate();
    const createRaw = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user:           wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: strategyParams,
      slippage: config.slippageBps / 100,
    });

    const txs = Array.isArray(createRaw) ? createRaw : [createRaw];
    const sigs = await sendTxs(conn, txs, [wallet, newPosition]);

    const binStep = Number((dlmmPool as any).lbPair?.binStep ?? 0);
    const priceRangeMin = priceAtBinId(dlmmPool, minBinId, binStep);
    const priceRangeMax = priceAtBinId(dlmmPool, maxBinId, binStep);

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
      rentSol,
    };

  } catch (err) {
    logger.error('Deploy position failed', { err });
    return { success: false, error: (err as Error).message };
  }
}

// ── Fee accounting ─────────────────────────────────────────────

function feesToSol(feeXRaw: number, feeYRaw: number, sides: PoolSides, currentPrice: number): number {
  const feeXTokens = feeXRaw / Math.pow(10, sides.decimalsX);
  const feeYTokens = feeYRaw / Math.pow(10, sides.decimalsY);
  if (sides.solIsX) {
    const feeYInSol = currentPrice > 0 ? feeYTokens / currentPrice : 0;
    return feeXTokens + feeYInSol;
  } else {
    const feeXInSol = feeXTokens * currentPrice;
    return feeXInSol + feeYTokens;
  }
}

// ── DLMM-specific impermanent loss for single-sided SOL LP ─────
//
// Single-sided SOL (Y) deployed across N bins starting from activeBin downwards.
// When price moves to currentPrice, each bin i between minBinId and maxBinId
// holds either:
//   - SOL (Y) if currentPrice >= binPrice(i)  [price above bin → SOL side]
//   - token (X) if currentPrice < binPrice(i)  [price below bin → token side]
//
// This function computes the actual SOL-equivalent value of all bins and
// subtracts from deployed to get the true DLMM IL.

function computeDLMMIL(
  solDeployed: number,
  entryPrice: number,
  currentPrice: number,
  priceRangeMin: number,
  priceRangeMax: number,
  binCount: number,
  binStep: number,
): { positionValueSol: number; ilSol: number; tokenQty: number } {
  if (binCount <= 1) {
    const r = currentPrice / entryPrice;
    const v2il = 2 * Math.sqrt(r) / (1 + r) - 1;
    return {
      positionValueSol: solDeployed * (1 + v2il),
      ilSol: Math.max(0, solDeployed * Math.abs(v2il)),
      tokenQty: 0,
    };
  }

  let totalValueSol = new Decimal(0);
  let totalTokensX = new Decimal(0);

  const deployedPerBin = solDeployed / binCount;
  const deployedLamports = new Decimal(Math.floor(deployedPerBin * 1e9));

  // SOL is Y in most memecoin/SOL pools. Bins from min (lowest price) to max (entryPrice).
  // Each bin price = entryPrice * (1 + bs/10000)^(i - maxBinId) ... no, let's compute
  // accurately using actual bin prices.
  //
  // Single-sided SOL(Y) deployed from minBinId to maxBinId (active).
  // Bin i price p_i = entryPrice * (1 + bs/10000)^(activeBinId - i)  for i <= activeBinId
  // Actually using the SDK formula: p_i = (1 + bs/10000)^(i * ??? )
  //
  // Let's just use a piecewise approximation that models the actual DLMM behavior:
  // - Bins below current price → filled with token X
  // - Bins at/above current price → filled with SOL Y
  // For each bin, the amount of token X = SOL_value / bin_price_at_entry
  // For each bin, the amount of SOL Y = SOL_value

  const lowerPrice = priceRangeMin;
  const upperPrice = priceRangeMax;

  for (let i = 0; i < binCount; i++) {
    const frac = i / (binCount - 1);
    const binPriceAtEntry = lowerPrice * Math.pow(upperPrice / lowerPrice, frac);

    if (currentPrice >= binPriceAtEntry) {
      // Price above bin → bin holds SOL (Y). Full value = deployed amount.
      totalValueSol = totalValueSol.add(deployedLamports);
    } else {
      // Price below bin → all SOL was converted to token X at binPriceAtEntry.
      // Token X amount = SOL_deployed / binPriceAtEntry (in SOL per token terms)
      const tokensFromBin = deployedLamports.div(new Decimal(binPriceAtEntry));
      totalTokensX = totalTokensX.add(tokensFromBin);
    }
  }

  // Convert token X back to SOL at current price
  const tokenValueSol = totalTokensX.mul(new Decimal(currentPrice));
  totalValueSol = totalValueSol.add(tokenValueSol);

  const positionValueSolNum = Number(totalValueSol.div(1e9));
  const ilSolNum = Math.max(0, solDeployed - positionValueSolNum);

  return {
    positionValueSol: positionValueSolNum,
    ilSol: ilSolNum,
    tokenQty: Number(totalTokensX),
  };
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

    const activeBin   = await dlmmPool.getActiveBin();
    const currentPrice = safePriceFromLamport(dlmmPool, activeBin.price);

    const claimRaw = await dlmmPool.claimAllRewards({
      owner:    wallet.publicKey,
      positions: [position],
    });
    const txs = Array.isArray(claimRaw) ? claimRaw : [claimRaw];
    await sendTxs(conn, txs, [wallet]);

    const feesClaimedSol = feesToSol(feeXRaw, feeYRaw, sides, currentPrice);
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

    const activeBin   = await dlmmPool.getActiveBin();
    const currentPrice = safePriceFromLamport(dlmmPool, activeBin.price);

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

    const feesClaimedSol = feesToSol(feeXRaw, feeYRaw, sides, currentPrice);
    logger.info('Position closed', { poolAddress, positionPubkey, feesClaimedSol });
    return { success: true, feesClaimedSol, exitPrice: currentPrice };

  } catch (err) {
    logger.error('Close position failed', { err });
    return { success: false, feesClaimedSol: 0, exitPrice: 0, error: (err as Error).message };
  }
}

// ── Realizable-value swap quote ─────────────────────────────────
//
// When closing a position, the SOL side comes back as SOL but the non-SOL
// side has to be swapped to realize SOL value. On thin pools that swap can
// eat 10–30% slippage, so the position value at mid-price is too optimistic.
// Pre-quote it so the healer can decide STAY vs CLOSE with realistic data.

async function quoteTokenToSol(
  dlmmPool: DLMM,
  sides:    PoolSides,
  tokenAmountRaw: number,
): Promise<{ outSol: number; priceImpactPct: number } | null> {
  if (!Number.isFinite(tokenAmountRaw) || tokenAmountRaw <= 0) {
    return { outSol: 0, priceImpactPct: 0 };
  }

  // BN constructor asserts on non-integer / out-of-safe-range numbers.
  // Build from a precise integer string instead.
  const intStr = Math.floor(tokenAmountRaw).toString();
  if (!/^\d+$/.test(intStr)) return null;

  const swapForY = !sides.solIsX;   // we want SOL out — opposite side of token
  try {
    const binArrays = await dlmmPool.getBinArrayForSwap(swapForY, 3);
    if (!binArrays || binArrays.length === 0) return null;
    const inAmount    = new BN(intStr);
    const slippageBps = new BN(500);  // quote tolerance, not execution
    const quote = dlmmPool.swapQuote(inAmount, swapForY, slippageBps, binArrays, true);
    const outSol         = Number(quote.outAmount.toString()) / 1e9;
    const priceImpactPct = Number(quote.priceImpact.toString()) * 100;
    return { outSol, priceImpactPct };
  } catch (err) {
    // SDK asserts when liquidity in the queried bin arrays can't cover the
    // swap — natural for thin pools or amounts beyond the ±3 bin-array window.
    // Non-fatal: caller falls back to mid-price valuation.
    logger.debug('quoteTokenToSol skipped (insufficient liquidity in queried bin arrays)', {
      tokenAmountRaw,
      err: (err as Error).message,
    });
    return null;
  }
}

// ── Get live position data ─────────────────────────────────────

export interface LivePositionData {
  isInRange:         boolean;
  currentPrice:      number;
  feesEarnedSol:     number;
  positionValueSol:  number;     // value at mid-price (optimistic)
  realizableValueSol: number;    // value after swapping token side to SOL (realistic)
  closeSlippagePct:  number;     // price impact of that swap
  ilSol:             number;
  currentTvl:        number;
  currentVolume:     number;
  feeTvlRatio:       number;
}

export async function getLivePositionData(
  poolAddress:    string,
  positionPubkey: string,
  entryPrice:     number,
  solDeployed:    number,
): Promise<LivePositionData | null> {

  if (config.dryRun) {
    const pos = db.prepare(
      `SELECT id, opened_at, price_range_min, price_range_max, bin_count, bin_step,
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
    const isInRange     = currentPrice >= priceRangeMin && currentPrice <= priceRangeMax;
    const binCount      = pos.bin_count ?? config.binRange;
    const binStep       = pos.bin_step ?? 100;

    // DLMM-specific IL: per-bin valuation instead of Uniswap-v2 formula
    const ilResult = computeDLMMIL(
      solDeployed, entryPrice, currentPrice,
      priceRangeMin, priceRangeMax, binCount, binStep,
    );
    const positionValueSol = ilResult.positionValueSol;
    const ilSol = ilResult.ilSol;

    // Realizable value via swap quote against real on-chain liquidity.
    // Even in dry mode the pool's bins are real, so the slippage estimate is real.
    let realizableValueSol = positionValueSol;
    let closeSlippagePct   = 0;
    try {
      const dlmmPool = await getDLMM(getConnection(), new PublicKey(poolAddress));
      const sides    = getPoolSides(dlmmPool);
      const tokenDecimals = sides.solIsX ? sides.decimalsY : sides.decimalsX;
      const tokenSideRaw  = ilResult.tokenQty * Math.pow(10, tokenDecimals);
      const solSideSol    = positionValueSol - ilResult.tokenQty * currentPrice; // approx SOL bins
      const q = await quoteTokenToSol(dlmmPool, sides, tokenSideRaw);
      if (q) {
        realizableValueSol = Math.max(0, solSideSol) + q.outSol;
        closeSlippagePct   = q.priceImpactPct;
      }
    } catch (err) {
      logger.debug('[DRY RUN] realizable value quote skipped', { err: (err as Error).message });
    }

    // Live pool health via on-chain SDK
    let snapTvl = pos.tvl_usd ?? 0;
    let snapVolume = pos.volume_24h_usd ?? 0;
    let snapFeeTvl = pos.fee_tvl_ratio ?? 0;
    const poolHealth = await getLivePoolHealth(poolAddress);
    if (poolHealth && poolHealth.currentTvl > 0) {
      snapTvl = poolHealth.currentTvl;
    }

    // Fee accrual: fee_tvl_ratio from Meteora is annualized (APR-equivalent).
    // Convert to daily yield: divide by 365. Cap at 0.5% daily (182.5% APR).
    const stateKey = `dry_pos:${pos.id}`;
    const rawState = getState(stateKey);
    const state    = rawState
      ? JSON.parse(rawState)
      : { lastTickAt: pos.opened_at, pendingFees: 0 };
    const now      = Date.now();
    const deltaSec = Math.max(0, (now - state.lastTickAt) / 1000);
    if (isInRange) {
      let dailyYield: number;
      if (snapFeeTvl > 0) {
        // snapFeeTvl is annualized percent (e.g. 12.5 = 12.5% APR)
        dailyYield = Math.min(snapFeeTvl / 100 / 365, 0.005);
      } else {
        dailyYield = 0;
      }
      state.pendingFees += solDeployed * dailyYield * (deltaSec / 86400);
    }
    state.lastTickAt = now;
    setState(stateKey, JSON.stringify(state));

    return {
      isInRange,
      currentPrice,
      feesEarnedSol:    state.pendingFees,
      positionValueSol,
      realizableValueSol,
      closeSlippagePct,
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
    const currentPrice = safePriceFromLamport(dlmmPool, activeBin.price);

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

    const ilSol = Math.max(0, solDeployed - positionValueSol - feesEarnedSol);

    // Realizable value: SOL side comes back as SOL, token side has to be swapped.
    let realizableValueSol = positionValueSol;
    let closeSlippagePct   = 0;
    const tokenSideRaw = sides.solIsX ? posYRaw : posXRaw;
    const solSideRaw   = sides.solIsX ? posXRaw : posYRaw;
    const solSideSol   = solSideRaw / 1e9;
    const q = await quoteTokenToSol(dlmmPool, sides, tokenSideRaw);
    if (q) {
      realizableValueSol = solSideSol + q.outSol;
      closeSlippagePct   = q.priceImpactPct;
    }

    // Live pool health via on-chain SDK
    const poolHealth = await getLivePoolHealth(poolAddress);
    const liveTvl    = poolHealth?.currentTvl ?? 0;
    const liveFee    = poolHealth?.currentFeeRate ?? null;

    // Fallback to entry-time snapshot if on-chain TVL is unavailable
    const snap = db.prepare(
      `SELECT tvl_usd, volume_24h_usd, fee_tvl_ratio
       FROM positions WHERE position_pubkey = ? AND status = 'open'`
    ).get(positionPubkey) as any;

    const currentTvl    = liveTvl > 0 ? liveTvl : (snap?.tvl_usd ?? 0);
    const currentVolume = snap?.volume_24h_usd ?? 0;
    const feeTvlRatio   = liveFee !== null && liveFee > 0
      ? liveFee * 100        // dynamic fee as percent
      : (snap?.fee_tvl_ratio ?? 0);

    return {
      isInRange,
      currentPrice,
      feesEarnedSol,
      positionValueSol,
      realizableValueSol,
      closeSlippagePct,
      ilSol,
      currentTvl,
      currentVolume,
      feeTvlRatio,
    };
  } catch (err) {
    logger.warn('getLivePositionData failed', { err: (err as Error).message });
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
  checked:        number;
  orphans:        { id: number; symbol: string; reason: string }[];
  emptyClosed:    number;     // untracked empty positions cleaned up — rent recovered
  rentRecovered:  number;     // approximate SOL recovered from empty closes
}> {
  const open = getOpenPositions();
  if (open.length === 0 && config.dryRun) {
    return { checked: 0, orphans: [], emptyClosed: 0, rentRecovered: 0 };
  }

  if (config.dryRun) {
    logger.info('Reconciliation skipped (dry mode — nothing on-chain to verify)', { open: open.length });
    return { checked: open.length, orphans: [], emptyClosed: 0, rentRecovered: 0 };
  }

  const conn   = getConnection();
  const wallet = getWallet();
  const orphans: { id: number; symbol: string; reason: string }[] = [];

  // Group tracked positions by pool to make one on-chain call per pool.
  const byPool = new Map<string, any[]>();
  for (const p of open) {
    if (!byPool.has(p.pool_address)) byPool.set(p.pool_address, []);
    byPool.get(p.pool_address)!.push(p);
  }

  // Verify tracked positions
  const trackedKeysGlobal = new Set<string>(open.map(p => p.position_pubkey).filter(Boolean));
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

  // ── Untracked-empty cleanup ─────────────────────────────────────
  // Walk every position the wallet owns across ALL pools. Any position that
  // is not tracked in our DB AND has zero liquidity is a leftover from a
  // crashed close — close it to recover ~0.05–0.1 SOL of rent each.
  let emptyClosed   = 0;
  let rentRecovered = 0;
  try {
    const allUserPositions = await DLMM.getAllLbPairPositionsByUser(conn, wallet.publicKey);
    for (const [lbPairStr, info] of allUserPositions) {
      for (const pos of info.lbPairPositionsData) {
        const pkStr = pos.publicKey.toString();
        if (trackedKeysGlobal.has(pkStr)) continue;

        const isEmpty = pos.positionData.positionBinData.every(
          (b: any) => Number(b.positionXAmount ?? 0) === 0 && Number(b.positionYAmount ?? 0) === 0
        );
        if (!isEmpty) {
          logger.warn('Reconciliation: untracked NON-EMPTY position on-chain', {
            pool: lbPairStr, pubkey: pkStr,
          });
          continue;
        }

        try {
          const dlmmPool = await getDLMM(conn, new PublicKey(lbPairStr));
          const closeRaw = await dlmmPool.closePositionIfEmpty({
            owner:    wallet.publicKey,
            position: pos as any,
          });
          const txs = Array.isArray(closeRaw) ? closeRaw : [closeRaw];
          await sendTxs(conn, txs, [wallet]);
          emptyClosed   += 1;
          rentRecovered += 0.057;   // typical position rent — actual delta is in wallet balance
          logger.info('Reconciliation: closed untracked empty position', { pool: lbPairStr, pubkey: pkStr });
        } catch (err) {
          logger.warn('closePositionIfEmpty failed', {
            pool: lbPairStr, pubkey: pkStr, err: (err as Error).message,
          });
        }
      }
    }
  } catch (err) {
    logger.warn('Untracked-position scan failed', { err: (err as Error).message });
  }

  return { checked: open.length, orphans, emptyClosed, rentRecovered };
}


import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction,
  sendAndConfirmTransaction, SimulatedTransactionResponse,
} from '@solana/web3.js';
import DLMM, { StrategyType, getPriceOfBinByBinId } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import bs58 from 'bs58';
import { config } from '../config';
import { logger } from '../utils/logger';

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
    logger.info('[DRY RUN] Would deploy position', { poolAddress, strategy, solAmount, binRange });
    return {
      success:        true,
      positionPubkey: `dry_${Date.now()}`,
      txSignature:    `dry_tx_${Date.now()}`,
      entryPrice:     1.0,
      priceRangeMin:  0.95,
      priceRangeMax:  1.05,
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
    const simFees = Math.random() * 0.05;
    logger.info('[DRY RUN] Would claim fees', { feesClaimedSol: simFees });
    return { success: true, feesClaimedSol: simFees };
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
    const simFees = Math.random() * 0.08;
    logger.info('[DRY RUN] Would close position', { feesClaimedSol: simFees });
    return { success: true, feesClaimedSol: simFees, exitPrice: 1.0 + (Math.random() - 0.5) * 0.1 };
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
    const inRange = Math.random() > 0.2;
    const fees    = Math.random() * 0.05;
    return {
      isInRange:        inRange,
      currentPrice:     1.0 + (Math.random() - 0.5) * 0.1,
      feesEarnedSol:    fees,
      positionValueSol: solDeployed * (0.95 + Math.random() * 0.1),
      ilSol:            solDeployed * 0.02 * Math.random(),
      currentTvl:       50000 + Math.random() * 50000,
      currentVolume:    100000 + Math.random() * 100000,
      feeTvlRatio:      0.05 + Math.random() * 0.1,
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

    // Fetch fresh pool stats
    const stats = await fetchPoolStats(poolAddress);

    return {
      isInRange,
      currentPrice,
      feesEarnedSol,
      positionValueSol,
      ilSol,
      currentTvl:     stats?.tvl ?? 0,
      currentVolume:  stats?.volume24h ?? 0,
      feeTvlRatio:    stats?.feeTvlRatio ?? 0,
    };
  } catch (err) {
    logger.warn('getLivePositionData failed', { err });
    return null;
  }
}

// ── Pool stats from Meteora API ────────────────────────────────

interface PoolStats {
  tvl:          number;
  volume24h:    number;
  feeTvlRatio:  number;
}

const statsCache = new Map<string, { at: number; data: PoolStats }>();
const STATS_TTL_MS = 60 * 1000;

async function fetchPoolStats(poolAddress: string): Promise<PoolStats | null> {
  const cached = statsCache.get(poolAddress);
  if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached.data;

  try {
    const http = (await import('node-fetch')).default as unknown as typeof fetch;
    const res = await http(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
    if (!res.ok) return null;
    const d = await res.json() as any;
    const stats: PoolStats = {
      tvl:         parseFloat(d.liquidity ?? d.tvl ?? '0'),
      volume24h:   parseFloat(d.trade_volume_24h ?? d.volume_24h ?? '0'),
      feeTvlRatio: parseFloat(d.fee_tvl_ratio ?? d.fee_tvl_ratio_24h ?? '0'),
    };
    statsCache.set(poolAddress, { at: Date.now(), data: stats });
    return stats;
  } catch {
    return null;
  }
}

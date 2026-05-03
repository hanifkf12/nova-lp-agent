import {
  Connection, Keypair, PublicKey,
  sendAndConfirmTransaction, Transaction,
} from '@solana/web3.js';
import DLMM, { StrategyType, LbPosition } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import bs58 from 'bs58';
import { config } from '../config';
import { logger } from '../utils/logger';

let _connection: Connection | null = null;
let _wallet: Keypair | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return _connection;
}

export function getWallet(): Keypair {
  if (!_wallet) {
    _wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
  }
  return _wallet;
}

export async function getSolBalance(): Promise<number> {
  const conn   = getConnection();
  const wallet = getWallet();
  const bal    = await conn.getBalance(wallet.publicKey);
  return bal / 1e9;
}

// ── Strategy mapping ───────────────────────────────────────────

function toStrategyType(s: string): StrategyType {
  switch (s) {
    case 'curve':   return StrategyType.Curve;
    case 'bid_ask': return StrategyType.BidAsk;
    default:        return StrategyType.Spot;
  }
}

// ── Deploy LP position ─────────────────────────────────────────

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
    logger.info('[DRY RUN] Would deploy position', { poolAddress, strategy, solAmount });
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
    const conn        = getConnection();
    const wallet      = getWallet();
    const poolPubkey  = new PublicKey(poolAddress);
    const dlmmPool    = await DLMM.create(conn, poolPubkey);

    const activeBin   = await dlmmPool.getActiveBin();
    const entryPrice  = dlmmPool.fromPricePerLamport(Number(activeBin.price));

    // Calculate bin range
    const halfRange    = Math.floor(binRange / 2);
    const minBinId     = activeBin.binId - halfRange;
    const maxBinId     = activeBin.binId + halfRange;

    // Convert SOL to lamports
    const totalXLamports = new BN(solAmount * 0.5 * 1e9); // split 50/50
    const totalYLamports = new BN(solAmount * 0.5 * 1e9);

    const strategyType = toStrategyType(strategy);

    const newPosition  = Keypair.generate();
    const createTx     = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user:           wallet.publicKey,
      totalXAmount:   totalXLamports,
      totalYAmount:   totalYLamports,
      strategy: {
        maxBinId,
        minBinId,
        strategyType,
      },
      slippage: 1,
    });

    const txSig = await sendAndConfirmTransaction(conn, createTx, [wallet, newPosition]);

    // Price range from bins
    const priceRangeMin = dlmmPool.fromPricePerLamport(
      Number(dlmmPool.getBinArrays().find(() => true)?.account?.bins?.[0]?.price ?? 0)
    );

    logger.info('Position deployed', {
      poolAddress,
      positionPubkey: newPosition.publicKey.toString(),
      txSig,
    });

    return {
      success:        true,
      positionPubkey: newPosition.publicKey.toString(),
      txSignature:    txSig,
      entryPrice,
      priceRangeMin:  entryPrice * (1 - binRange * 0.001),
      priceRangeMax:  entryPrice * (1 + binRange * 0.001),
      binCount:       binRange,
    };

  } catch (err) {
    logger.error('Deploy position failed', { err });
    return { success: false, error: (err as Error).message };
  }
}

// ── Claim fees ─────────────────────────────────────────────────

export async function claimFees(
  poolAddress:    string,
  positionPubkey: string,
): Promise<{ success: boolean; feesClaimedSol: number }> {

  if (config.dryRun) {
    const simFees = Math.random() * 0.05;
    logger.info('[DRY RUN] Would claim fees', { feesClaimedSol: simFees });
    return { success: true, feesClaimedSol: simFees };
  }

  try {
    const conn       = getConnection();
    const wallet     = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await DLMM.create(conn, poolPubkey);
    const posPubkey  = new PublicKey(positionPubkey);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const position = userPositions.find(p =>
      p.publicKey.toString() === positionPubkey
    );

    if (!position) return { success: false, feesClaimedSol: 0 };

    const claimTx = await dlmmPool.claimAllRewards({
      owner:    wallet.publicKey,
      position: posPubkey,
    });

    await sendAndConfirmTransaction(conn, claimTx as Transaction, [wallet]);

    // Estimate fees from position data
    const feesX = Number(position.positionData.feeX) / 1e9;
    const feesY = Number(position.positionData.feeY) / 1e9;

    return { success: true, feesClaimedSol: feesX + feesY };
  } catch (err) {
    logger.error('Claim fees failed', { err });
    return { success: false, feesClaimedSol: 0 };
  }
}

// ── Close position ─────────────────────────────────────────────

export async function closePosition(
  poolAddress:    string,
  positionPubkey: string,
): Promise<{ success: boolean; feesClaimedSol: number; error?: string }> {

  if (config.dryRun) {
    const simFees = Math.random() * 0.08;
    logger.info('[DRY RUN] Would close position', { feesClaimedSol: simFees });
    return { success: true, feesClaimedSol: simFees };
  }

  try {
    const conn       = getConnection();
    const wallet     = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await DLMM.create(conn, poolPubkey);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const position = userPositions.find(p =>
      p.publicKey.toString() === positionPubkey
    );

    if (!position) return { success: false, feesClaimedSol: 0, error: 'Position not found' };

    const feesX = Number(position.positionData.feeX) / 1e9;
    const feesY = Number(position.positionData.feeY) / 1e9;

    const binIds = position.positionData.positionBinData.map((b: any) => b.binId);
    const removeTx = await dlmmPool.removeLiquidity({
      position: new PublicKey(positionPubkey),
      user:     wallet.publicKey,
      binIds,
      bpsToRemove: new BN(10000), // 100%
      shouldClaimAndClose: true,
    });

    await sendAndConfirmTransaction(conn, removeTx as Transaction, [wallet]);

    logger.info('Position closed', { poolAddress, positionPubkey });
    return { success: true, feesClaimedSol: feesX + feesY };

  } catch (err) {
    logger.error('Close position failed', { err });
    return { success: false, feesClaimedSol: 0, error: (err as Error).message };
  }
}

// ── Get live position data ─────────────────────────────────────

export async function getLivePositionData(
  poolAddress:    string,
  positionPubkey: string,
): Promise<{
  isInRange:     boolean;
  currentPrice:  number;
  feesEarnedSol: number;
  currentTvl:    number;
  currentVolume: number;
  feeTvlRatio:   number;
} | null> {

  if (config.dryRun) {
    // Simulasi data live
    return {
      isInRange:     Math.random() > 0.2,
      currentPrice:  1.0 + (Math.random() - 0.5) * 0.1,
      feesEarnedSol: Math.random() * 0.05,
      currentTvl:    50000 + Math.random() * 50000,
      currentVolume: 100000 + Math.random() * 100000,
      feeTvlRatio:   0.05 + Math.random() * 0.1,
    };
  }

  try {
    const conn       = getConnection();
    const wallet     = getWallet();
    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool   = await DLMM.create(conn, poolPubkey);

    const activeBin  = await dlmmPool.getActiveBin();
    const currentPrice = dlmmPool.fromPricePerLamport(Number(activeBin.price));

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const position = userPositions.find(p =>
      p.publicKey.toString() === positionPubkey
    );

    if (!position) return null;

    const posData  = position.positionData;
    const minBinId = Math.min(...posData.positionBinData.map((b: any) => b.binId));
    const maxBinId = Math.max(...posData.positionBinData.map((b: any) => b.binId));
    const isInRange = activeBin.binId >= minBinId && activeBin.binId <= maxBinId;

    const feesX = Number(posData.feeX) / 1e9;
    const feesY = Number(posData.feeY) / 1e9;

    return {
      isInRange,
      currentPrice,
      feesEarnedSol: feesX + feesY,
      currentTvl:    0, // fetch from Meteora API if needed
      currentVolume: 0,
      feeTvlRatio:   0,
    };
  } catch {
    return null;
  }
}

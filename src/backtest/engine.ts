import { db, getState, setState } from '../db';
import { logger } from '../utils/logger';

export interface BacktestSnapshot {
  timestamp: number;
  poolAddress: string;
  tokenSymbol: string;
  currentPrice: number;
  tvlSol: number;
  feeRate: number;
  holderCount: number;
  volume24hSol: number;
}

export interface BacktestResult {
  positions: number;
  wins: number;
  losses: number;
  totalFeesSol: number;
  totalPnLSol: number;
  avgApr: number;
  maxDrawdown: number;
  scoreThreshold: number;
}

function recordSnapshot(snap: BacktestSnapshot): void {
  db.prepare(`
    INSERT OR REPLACE INTO backtest_snapshots
    (timestamp, pool_address, token_symbol, current_price, tvl_sol, fee_rate, holder_count, volume_24h_sol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snap.timestamp, snap.poolAddress, snap.tokenSymbol,
    snap.currentPrice, snap.tvlSol, snap.feeRate,
    snap.holderCount, snap.volume24hSol,
  );
}

export function getSnapshots(
  poolAddress: string,
  since: number,
  until: number,
): BacktestSnapshot[] {
  return db.prepare(`
    SELECT * FROM backtest_snapshots
    WHERE pool_address = ?
      AND timestamp >= ?
      AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(poolAddress, since, until) as any[];
}

export function allSnapshotSymbols(): string[] {
  return (db.prepare(
    `SELECT DISTINCT token_symbol FROM backtest_snapshots ORDER BY token_symbol`
  ).all() as any[]).map(r => r.token_symbol);
}

export function snapshotsForSymbol(symbol: string): BacktestSnapshot[] {
  return db.prepare(
    `SELECT * FROM backtest_snapshots WHERE token_symbol = ? ORDER BY timestamp ASC`
  ).all(symbol) as any[];
}

export function recordBacktestRun(result: BacktestResult): void {
  db.prepare(`
    INSERT INTO backtest_runs (run_at, params, result)
    VALUES (?, ?, ?)
  `).run(
    Date.now(),
    JSON.stringify({ scoreThreshold: result.scoreThreshold }),
    JSON.stringify(result),
  );
}

export function getBestScoreThreshold(): { threshold: number; winRate: number } | null {
  const run = db.prepare(
    `SELECT params, result FROM backtest_runs ORDER BY run_at DESC LIMIT 1`
  ).get() as any;
  if (!run) return null;
  const r = JSON.parse(run.result);
  return { threshold: r.scoreThreshold, winRate: r.wins / Math.max(1, r.positions) };
}

const IL_MIN_AGE_SEC = 3_600;

export function runBacktest(
  snapshots: BacktestSnapshot[],
  opts: {
    scoreThreshold: number;
    solPerPosition: number;
    binCount: number;
    binStep: number;
  },
): BacktestResult {
  const results: { pnlSol: number; feesSol: number; apr: number; won: boolean }[] = [];
  let drawdown = 0;
  let peak = opts.solPerPosition * 5;
  let currentValue = peak;

  for (let i = 0; i < snapshots.length; i++) {
    const entry = snapshots[i];

    if (entry.feeRate <= 0) continue;

    for (let j = i + 1; j < snapshots.length; j += Math.max(1, Math.floor((j - i) / 24))) {
      const exit = snapshots[j];
      const hours = (exit.timestamp - entry.timestamp) / 3_600_000;
      if (hours < 0.5) continue;
      if (hours > 168) break;

      const priceRatio = exit.currentPrice / entry.currentPrice;
      if (!isFinite(priceRatio) || priceRatio <= 0) continue;

      let positionValue: number;
      if (opts.binCount <= 1) {
        const r = priceRatio;
        const il = 2 * Math.sqrt(r) / (1 + r) - 1;
        positionValue = opts.solPerPosition * (1 + il);
      } else {
        const lowerPrice = entry.currentPrice / Math.pow(1 + opts.binStep / 10000, opts.binCount - 1);
        const upperPrice = entry.currentPrice;
        let totalSol = 0;
        let totalToken = 0;
        const perBin = opts.solPerPosition / opts.binCount;

        for (let b = 0; b < opts.binCount; b++) {
          const frac = b / (opts.binCount - 1);
          const binPrice = lowerPrice * Math.pow(upperPrice / lowerPrice, frac);
          if (exit.currentPrice >= binPrice) {
            totalSol += perBin;
          } else {
            totalToken += perBin / binPrice;
          }
        }
        positionValue = totalSol + totalToken * exit.currentPrice;
      }

      const feeTime = Math.min(
        hours,
        (j < snapshots.length - 1)
          ? Math.min(24, (exit.timestamp - entry.timestamp) / 3_600_000)
          : 0,
      );
      const fees = opts.solPerPosition * entry.feeRate * (feeTime / 24);
      const pnl = positionValue + fees - opts.solPerPosition;
      const apr = opts.solPerPosition > 0 ? (fees / opts.solPerPosition) * (8760 / hours) * 100 : 0;

      results.push({ pnlSol: pnl, feesSol: fees, apr, won: pnl > 0 });

      currentValue += pnl;
      peak = Math.max(peak, currentValue);
      const dd = peak > 0 ? (peak - currentValue) / peak : 0;
      drawdown = Math.max(drawdown, dd);

      break;
    }
  }

  const wins = results.filter(r => r.won).length;
  return {
    positions: results.length,
    wins,
    losses: results.length - wins,
    totalFeesSol: results.reduce((s, r) => s + r.feesSol, 0),
    totalPnLSol: results.reduce((s, r) => s + r.pnlSol, 0),
    avgApr: results.length > 0 ? results.reduce((s, r) => s + r.apr, 0) / results.length : 0,
    maxDrawdown: drawdown,
    scoreThreshold: opts.scoreThreshold,
  };
}

export function optimizeScoreWeight(
  snapshots: BacktestSnapshot[],
  opts: { solPerPosition: number; binCount: number; binStep: number },
): { bestThreshold: number; bestResult: BacktestResult } {
  let bestResult: BacktestResult | null = null;
  let bestThreshold = 65;

  for (let t = 40; t <= 95; t += 5) {
    const result = runBacktest(snapshots, { ...opts, scoreThreshold: t });
    if (!bestResult || (result.wins / Math.max(1, result.positions)) > (bestResult.wins / Math.max(1, bestResult.positions))) {
      bestResult = result;
      bestThreshold = t;
    }
    logger.info('Backtest sweep', {
      threshold: t,
      positions: result.positions,
      winRate: Math.round((result.wins / Math.max(1, result.positions)) * 100),
      avgPnL: result.totalPnLSol.toFixed(4),
      avgApr: result.avgApr.toFixed(1),
    });
  }

  return { bestThreshold, bestResult: bestResult! };
}

export function collectSnapshot(pool: {
  poolAddress: string;
  tokenSymbol: string;
  currentPrice: number;
  tvlSol: number;
  feeRate: number;
  holderCount: number;
  volume24hSol: number;
}): void {
  recordSnapshot({
    timestamp: Date.now(),
    poolAddress: pool.poolAddress,
    tokenSymbol: pool.tokenSymbol,
    currentPrice: pool.currentPrice,
    tvlSol: pool.tvlSol,
    feeRate: pool.feeRate,
    holderCount: pool.holderCount,
    volume24hSol: pool.volume24hSol,
  });
}

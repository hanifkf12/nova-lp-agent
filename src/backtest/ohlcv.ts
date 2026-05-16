// OHLCV backfill for the backtest engine.
//
// Pulls historical price + volume from the Meteora DLMM REST API and writes
// per-hour rows into the existing backtest_snapshots table. This gives the
// engine real out-of-sample history to replay against — vs the in-sample
// data the agent itself recorded while running.

import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

interface OhlcvCandle {
  timestamp: number;     // unix seconds
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;     // in USD
}

interface VolumeBucket {
  timestamp: number;
  volume:    number;
}

// Fetch OHLCV candles for one pool.
// Endpoint shape per Meteora docs: GET /pools/{address}/ohlcv
// We probe a few common parameter names since the public schema is sparse.
async function fetchOhlcv(
  poolAddress: string,
  fromUnix:    number,
  toUnix:      number,
  intervalSec: number = 3600,
): Promise<OhlcvCandle[]> {
  const http = (await import('node-fetch')).default as unknown as typeof fetch;
  const url = `${config.meteoraDlmmApi}/pools/${poolAddress}/ohlcv` +
    `?from=${fromUnix}&to=${toUnix}&interval=${intervalSec}`;

  const res = await http(url);
  if (!res.ok) {
    throw new Error(`OHLCV ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json() as any;
  const rows: any[] = Array.isArray(data) ? data : (data.candles ?? data.data ?? []);

  return rows.map(r => ({
    timestamp: Number(r.t ?? r.timestamp ?? r.time ?? 0),
    open:      Number(r.o ?? r.open  ?? 0),
    high:      Number(r.h ?? r.high  ?? 0),
    low:       Number(r.l ?? r.low   ?? 0),
    close:     Number(r.c ?? r.close ?? 0),
    volume:    Number(r.v ?? r.volume ?? 0),
  })).filter(c => c.timestamp > 0 && c.close > 0);
}

async function fetchVolumeHistory(
  poolAddress: string,
  fromUnix:    number,
  toUnix:      number,
): Promise<VolumeBucket[]> {
  const http = (await import('node-fetch')).default as unknown as typeof fetch;
  const url = `${config.meteoraDlmmApi}/pools/${poolAddress}/volume/history` +
    `?from=${fromUnix}&to=${toUnix}`;
  try {
    const res = await http(url);
    if (!res.ok) return [];
    const data = await res.json() as any;
    const rows: any[] = Array.isArray(data) ? data : (data.buckets ?? data.data ?? []);
    return rows.map(r => ({
      timestamp: Number(r.t ?? r.timestamp ?? r.time ?? 0),
      volume:    Number(r.v ?? r.volume ?? 0),
    })).filter(b => b.timestamp > 0);
  } catch {
    return [];
  }
}

// Pull symbol from current pool detail to label snapshots usefully.
async function fetchPoolSymbol(poolAddress: string): Promise<string> {
  const http = (await import('node-fetch')).default as unknown as typeof fetch;
  try {
    const res = await http(`${config.meteoraDlmmApi}/pools/${poolAddress}`);
    if (!res.ok) return 'UNK';
    const d = await res.json() as any;
    return d.token_x?.symbol ?? d.name?.split('-')?.[0] ?? 'UNK';
  } catch {
    return 'UNK';
  }
}

export async function backfillFromOhlcv(
  poolAddress: string,
  days: number,
): Promise<{ inserted: number; symbol: string }> {
  const toUnix   = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - days * 86400;

  logger.info('OHLCV backfill starting', { poolAddress, days });

  const [candles, volumes, symbol] = await Promise.all([
    fetchOhlcv(poolAddress, fromUnix, toUnix),
    fetchVolumeHistory(poolAddress, fromUnix, toUnix),
    fetchPoolSymbol(poolAddress),
  ]);

  if (candles.length === 0) {
    throw new Error('No OHLCV candles returned — check the pool address and API endpoint');
  }

  // Index volume buckets by timestamp for a quick join with candles.
  const volByTs = new Map<number, number>();
  for (const v of volumes) volByTs.set(v.timestamp, v.volume);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO backtest_snapshots
    (timestamp, pool_address, token_symbol, current_price, tvl_sol, fee_rate, holder_count, volume_24h_sol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction((rows: typeof candles) => {
    let n = 0;
    for (const c of rows) {
      const tsMs   = c.timestamp * 1000;
      const volume = volByTs.get(c.timestamp) ?? c.volume;
      // tvl_sol, fee_rate, holder_count not in OHLCV — leave 0; engine
      // tolerates these and still computes IL from price ratio + bin geometry.
      insert.run(tsMs, poolAddress, symbol, c.close, 0, 0, 0, volume);
      n++;
    }
    return n;
  });

  const inserted = txn(candles);
  logger.info('OHLCV backfill done', { poolAddress, symbol, inserted, candles: candles.length });
  return { inserted, symbol };
}

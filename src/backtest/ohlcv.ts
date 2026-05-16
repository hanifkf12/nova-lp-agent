// OHLCV backfill for the backtest engine.
//
// Meteora's per-pool OHLCV endpoint isn't publicly served — the docs reference
// it but no host responds. We use Birdeye's /defi/ohlcv instead, fetching by
// token mint. The backtest engine compares price RATIOS (entry vs exit), so
// USD-denominated candles work identically to SOL-denominated ones for the IL
// math. Output PnL stays in SOL because solPerPosition is the input.
//
// Flow: pool address → (Meteora discovery) → token_x.mint → (Birdeye) → candles.

import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

interface BirdeyeCandle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  unixTime: number;
}

interface PoolMeta {
  tokenMint:   string;
  tokenSymbol: string;
  binStep:     number;
}

async function fetchPoolMeta(poolAddress: string): Promise<PoolMeta> {
  const http = (await import('node-fetch')).default as unknown as typeof fetch;
  const res = await http(
    `${config.meteoraDlmmApi}/pools?pool_address=${poolAddress}&limit=1`
  );
  if (!res.ok) throw new Error(`Discovery API ${res.status}`);
  const data = await res.json() as any;
  const pool = (data.data ?? data.pools ?? [])[0];
  if (!pool) throw new Error(`Pool ${poolAddress} not found in discovery API`);
  return {
    tokenMint:   pool.token_x?.address,
    tokenSymbol: pool.token_x?.symbol ?? 'UNK',
    binStep:     parseInt(pool.dlmm_params?.bin_step ?? '100'),
  };
}

async function fetchBirdeyeOhlcv(
  mint:     string,
  fromUnix: number,
  toUnix:   number,
  type:     '1H' | '15m' | '1D' = '1H',
): Promise<BirdeyeCandle[]> {
  if (!config.birdeyeKey) {
    throw new Error('BIRDEYE_API_KEY not set — required for OHLCV backfill');
  }
  const http = (await import('node-fetch')).default as unknown as typeof fetch;
  const url = `https://public-api.birdeye.so/defi/ohlcv` +
    `?address=${mint}&type=${type}&time_from=${fromUnix}&time_to=${toUnix}`;
  const res = await http(url, { headers: { 'X-API-KEY': config.birdeyeKey } });
  if (!res.ok) {
    throw new Error(`Birdeye OHLCV ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json() as any;
  const items: any[] = data?.data?.items ?? [];
  return items
    .map(r => ({
      o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c),
      v: Number(r.v), unixTime: Number(r.unixTime),
    }))
    .filter(c => c.unixTime > 0 && c.c > 0);
}

export async function backfillFromOhlcv(
  poolAddress: string,
  days:        number,
): Promise<{ inserted: number; symbol: string; binStep: number }> {
  const toUnix   = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - days * 86400;

  logger.info('OHLCV backfill starting', { poolAddress, days });

  const meta = await fetchPoolMeta(poolAddress);
  if (!meta.tokenMint) {
    throw new Error(`No token mint found for pool ${poolAddress}`);
  }
  logger.info('Pool meta resolved', meta);

  const candles = await fetchBirdeyeOhlcv(meta.tokenMint, fromUnix, toUnix, '1H');
  if (candles.length === 0) {
    throw new Error('No candles returned from Birdeye — token may be too new or have no trading history');
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO backtest_snapshots
    (timestamp, pool_address, token_symbol, current_price, tvl_sol, fee_rate, holder_count, volume_24h_sol)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Estimate a fee_rate per hour from the pool's bin_step. Meteora's base fee
  // for DLMM is roughly (binStep / 10000) per swap; for backtest fee accrual
  // we approximate hourly fee/TVL as 0.5% (conservative) when we have no
  // actual fee data. Engine clamps absurd values; this avoids divide-by-zero.
  const approxHourlyFeeRate = Math.max(0.005, meta.binStep / 10000);

  const txn = db.transaction((rows: BirdeyeCandle[]) => {
    let n = 0;
    for (const c of rows) {
      insert.run(
        c.unixTime * 1000,
        poolAddress,
        meta.tokenSymbol,
        c.c,                       // close price in USD (engine uses ratios)
        0,                         // tvl_sol — Birdeye doesn't expose; engine OK with 0
        approxHourlyFeeRate,
        0,                         // holder_count — not used by engine
        c.v,                       // volume in USD
      );
      n++;
    }
    return n;
  });

  const inserted = txn(candles);
  logger.info('OHLCV backfill done', {
    poolAddress, symbol: meta.tokenSymbol, inserted, candles: candles.length,
  });
  return { inserted, symbol: meta.tokenSymbol, binStep: meta.binStep };
}

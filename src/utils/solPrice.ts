import { config } from '../config';
import { setState } from '../db';
import { logger } from './logger';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let lastFetch = 0;
let lastPrice = 0;
const TTL_MS = 5 * 60 * 1000;

async function fromJupiter(http: typeof fetch): Promise<number | null> {
  try {
    const res = await http(`https://lite-api.jup.ag/price/v2?ids=${SOL_MINT}`);
    if (!res.ok) return null;
    const d = await res.json() as any;
    const p = parseFloat(d?.data?.[SOL_MINT]?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function fromBirdeye(http: typeof fetch): Promise<number | null> {
  if (!config.birdeyeKey) return null;
  try {
    const res = await http(`https://public-api.birdeye.so/defi/price?address=${SOL_MINT}`, {
      headers: { 'X-API-KEY': config.birdeyeKey },
    });
    if (!res.ok) return null;
    const d = await res.json() as any;
    const p = parseFloat(d?.data?.value);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export async function refreshSolPriceUsd(): Promise<number> {
  if (Date.now() - lastFetch < TTL_MS && lastPrice > 0) return lastPrice;

  const http = (await import('node-fetch')).default as unknown as typeof fetch;
  const price = (await fromJupiter(http)) ?? (await fromBirdeye(http));

  if (price && price > 0) {
    lastFetch = Date.now();
    lastPrice = price;
    setState('sol_price_usd', String(price));
    logger.info('SOL price refreshed', { usd: price });
    return price;
  }

  logger.warn('SOL price fetch failed — keeping last known');
  return lastPrice || 150;
}

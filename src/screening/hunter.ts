import { config } from '../config';
import { isPoolOnCooldown } from '../db';
import { logger } from '../utils/logger';

const DISCOVERY_API = config.meteoraDlmmApi;
const BIRDEYE_API   = 'https://public-api.birdeye.so';

// Per-pool detail refresh — used by the healer to detect decay (organic score
// dropping, holders leaving, fee/TVL collapsing) without re-running the full
// candidate-screening pipeline. One HTTP call per healer cycle per position;
// well under the 30 RPS limit.
export interface PoolDetail {
  organicScore: number;
  holderCount:  number;
  tvlUsd:       number;
  volume24hUsd: number;
  feeTvlRatio:  number;
}

export async function fetchPoolDetail(poolAddress: string): Promise<PoolDetail | null> {
  try {
    const http = (await import('node-fetch')).default as unknown as typeof fetch;
    const res = await http(`${DISCOVERY_API}/pools/${poolAddress}`);
    if (!res.ok) return null;
    const d = await res.json() as any;
    return {
      organicScore: parseFloat(d.token_x?.organic_score ?? d.organic_score ?? '0'),
      holderCount:  parseInt(d.base_token_holders ?? d.token_x?.holders ?? '0'),
      tvlUsd:       parseFloat(d.tvl ?? '0'),
      volume24hUsd: parseFloat(d.volume ?? '0'),
      feeTvlRatio:  parseFloat(d.fee_tvl_ratio ?? '0'),
    };
  } catch (err) {
    logger.debug('fetchPoolDetail failed', { poolAddress, err: (err as Error).message });
    return null;
  }
}

export interface PoolCandidate {
  poolAddress:   string;
  tokenMint:     string;
  tokenSymbol:   string;
  binStep:       number;
  tvlUsd:        number;
  volume24hUsd:  number;
  feeTvlRatio:   number;
  organicScore:  number;
  holderCount:   number;
  mcapUsd:       number;
  currentPrice:  number;
  priceChange24h: number;
  isWash:        boolean;
  isRugpull:     boolean;

  // Computed
  novaScore:     number;
  riskLevel:     'LOW' | 'MEDIUM' | 'HIGH';
}

// ── Multi-layer pool scoring ───────────────────────────────────

function computeNovaScore(pool: Partial<PoolCandidate>): number {
  let score = 0;

  // 1. Fee efficiency (0–30 pts) — paling penting
  const feeRatio = pool.feeTvlRatio ?? 0;
  score += Math.min(feeRatio * 200, 30);

  // 2. Volume (0–20 pts)
  const vol = pool.volume24hUsd ?? 0;
  if (vol > 500_000) score += 20;
  else if (vol > 200_000) score += 15;
  else if (vol > 50_000) score += 10;
  else if (vol > 20_000) score += 5;

  // 3. Organic score (0–20 pts)
  score += Math.min((pool.organicScore ?? 0) / 5, 20);

  // 4. TVL sweet spot (0–15 pts) — tidak terlalu besar, tidak terlalu kecil
  const tvl = pool.tvlUsd ?? 0;
  if (tvl >= 20_000 && tvl <= 100_000) score += 15;
  else if (tvl >= 10_000 && tvl <= 200_000) score += 10;
  else if (tvl >= config.screening.minTvl) score += 5;

  // 5. Holder count (0–10 pts)
  const holders = pool.holderCount ?? 0;
  if (holders > 2000) score += 10;
  else if (holders > 500) score += 7;
  else if (holders > 200) score += 4;
  else if (holders > 100) score += 2;

  // 6. Penalties
  if (pool.isWash)          score -= 50;
  if (pool.isRugpull)       score -= 100;

  return Math.max(0, Math.min(100, score));
}

function getRiskLevel(pool: Partial<PoolCandidate>): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (pool.isRugpull || pool.isWash) return 'HIGH';
  if ((pool.holderCount ?? 0) < 200) return 'MEDIUM';
  return 'LOW';
}

// ── Meteora Discovery API ──────────────────────────────────────

async function fetchMeteoraPools(http: typeof fetch): Promise<any[]> {
  const sc = config.screening;
  const params = new URLSearchParams({
    min_tvl:              String(sc.minTvl),
    max_tvl:              String(sc.maxTvl),
    min_fee_tvl_ratio:    String(sc.minFeeTvlRatio),
    min_volume_24h:       String(sc.minVolume24h),
    min_organic_score:    String(sc.minOrganicScore),
    min_bin_step:         String(sc.minBinStep),
    max_bin_step:         String(sc.maxBinStep),
    no_critical_warnings: 'true',
    no_high_ownership:    'true',
    limit:                '50',
  });

  const res  = await http(`${DISCOVERY_API}/pools?${params}`);
  if (!res.ok) throw new Error(`Meteora discovery API ${res.status}`);
  const data = await res.json() as any;
  const pools = Array.isArray(data) ? data : (data.pools ?? data.data ?? []);
  return pools.filter((p: any) => p.pool_type === 'dlmm');
}

// ── Birdeye token enrichment ───────────────────────────────────

async function enrichWithBirdeye(http: typeof fetch, mint: string): Promise<{
  holderCount: number;
  mcapUsd:     number;
  priceChange24h: number;
}> {
  if (!config.birdeyeKey) return { holderCount: 0, mcapUsd: 0, priceChange24h: 0 };

  try {
    const res = await http(`${BIRDEYE_API}/defi/token_overview?address=${mint}`, {
      headers: { 'X-API-KEY': config.birdeyeKey }
    });
    if (!res.ok) return { holderCount: 0, mcapUsd: 0, priceChange24h: 0 };
    const d = (await res.json() as any)?.data;
    return {
      holderCount:   d?.holder ?? 0,
      mcapUsd:       d?.mc ?? 0,
      priceChange24h: d?.priceChange24hPercent ?? 0,
    };
  } catch {
    return { holderCount: 0, mcapUsd: 0, priceChange24h: 0 };
  }
}

// ── Main hunter function ──────────────────────────────────────

export async function huntPools(): Promise<PoolCandidate[]> {
  const http = (await import('node-fetch')).default as unknown as typeof fetch;

  logger.info('Hunter: scanning Meteora pools...');

  let raw: any[];
  try {
    raw = await fetchMeteoraPools(http);
  } catch (err) {
    logger.error('Failed to fetch pools', { err });
    return [];
  }

  logger.info(`Hunter: got ${raw.length} raw pools`);
  if (raw.length > 0) logger.info('Sample:', { 
    name: raw[0].name, 
    tvl: raw[0].tvl, 
    volume: raw[0].volume,
    feeTvlRatio: raw[0].fee_tvl_ratio,
    tokenX: raw[0].token_x?.symbol,
    organicScore: raw[0].token_x?.organic_score,
    holders: raw[0].base_token_holders,
  });

  const filtered = raw.filter(p => {
    const mint = p.token_x?.address;
    return mint && !isPoolOnCooldown(p.pool_address);
  });
  logger.info(`After cooldown filter: ${filtered.length}`);

  const top = filtered.slice(0, 15);
  const enriched = await Promise.all(top.map(async (p): Promise<PoolCandidate | null> => {
    const mint    = p.token_x?.address;
    const symbol  = p.token_x?.symbol ?? 'UNK';
    const address = p.pool_address;

    if (!mint || !address) return null;

    const bird = await enrichWithBirdeye(http, mint);

    const candidate: PoolCandidate = {
      poolAddress:   address,
      tokenMint:     mint,
      tokenSymbol:   symbol,
      binStep:       parseInt(p.dlmm_params?.bin_step ?? '100'),
      tvlUsd:        parseFloat(p.tvl ?? '0'),
      volume24hUsd:  parseFloat(p.volume ?? '0'),
      feeTvlRatio:   parseFloat(p.fee_tvl_ratio ?? '0'),
      organicScore:  parseFloat(p.token_x?.organic_score ?? '0'),
      currentPrice:  parseFloat(p.pool_price ?? '0'),
      priceChange24h: bird.priceChange24h,
      holderCount:   bird.holderCount || parseInt(p.base_token_holders ?? p.token_x?.holders ?? '0'),
      mcapUsd:       bird.mcapUsd    || parseFloat(p.token_x?.market_cap ?? '0'),
      isWash:        false,
      isRugpull:     p.is_blacklisted ?? false,
      novaScore:     0,
      riskLevel:     'MEDIUM',
    };

    // Compute composite score
    candidate.novaScore     = computeNovaScore(candidate);
    candidate.riskLevel     = getRiskLevel(candidate);

    return candidate;
  }));

  const valid = enriched
    .filter((c): c is PoolCandidate => c !== null)
    .filter(c => !c.isWash && !c.isRugpull)
    .filter(c => c.mcapUsd <= config.screening.maxMcap || c.mcapUsd === 0)
    .filter(c => c.holderCount >= config.screening.minHolders || c.holderCount === 0)
    .sort((a, b) => b.novaScore - a.novaScore);

  logger.info(`Hunter: ${valid.length} qualified candidates`, {
    top: valid.slice(0, 3).map(c => `${c.tokenSymbol}(${c.novaScore.toFixed(0)})`).join(', ')
  });

  return valid;
}

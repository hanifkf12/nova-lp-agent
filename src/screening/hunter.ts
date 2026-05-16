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
  bundlePct:     number;
  isWash:        boolean;
  isRugpull:     boolean;
  kolPresent:    boolean;
  whalePresent:  boolean;
  deployerAddress?: string;

  // Computed
  novaScore:     number;   // 0–100 composite score
  riskLevel:     'LOW' | 'MEDIUM' | 'HIGH';
  recommendation: string;
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

  // 6. KOL / whale bonus (+5)
  if (pool.kolPresent)   score += 3;
  if (pool.whalePresent) score += 2;

  // 7. Penalties
  if (pool.isWash)          score -= 50;
  if (pool.isRugpull)       score -= 100;
  if ((pool.bundlePct ?? 0) > 30) score -= 15;
  if ((pool.bundlePct ?? 0) > 50) score -= 20;

  return Math.max(0, Math.min(100, score));
}

function getRiskLevel(pool: Partial<PoolCandidate>): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (pool.isRugpull || pool.isWash) return 'HIGH';
  if ((pool.bundlePct ?? 0) > 40) return 'HIGH';
  if ((pool.bundlePct ?? 0) > 20 || (pool.holderCount ?? 0) < 200) return 'MEDIUM';
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

// ── Whale/KOL detection via Helius ────────────────────────────

const decimalsCache = new Map<string, number>();

async function getTokenDecimals(http: typeof fetch, mint: string): Promise<number> {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint)!;
  if (!config.heliusKey) return 0;

  try {
    const res = await http(
      `https://api.helius.xyz/v0/token-metadata?api-key=${config.heliusKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintAccounts: [mint] }),
      }
    );
    if (!res.ok) return 0;
    const meta = (await res.json()) as any[];
    const dec = meta[0]?.onChainMetadata?.metadata?.data?.decimals ?? 0;
    decimalsCache.set(mint, dec);
    return dec;
  } catch {
    return 0;
  }
}

async function checkWhaleActivity(http: typeof fetch, mint: string): Promise<{
  whalePresent: boolean;
  kolPresent:   boolean;
  bundlePct:    number;
}> {
  if (!config.heliusKey) return { whalePresent: false, kolPresent: false, bundlePct: 0 };

  try {
    const decimals = await getTokenDecimals(http, mint);

    const res = await http(
      `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${config.heliusKey}&limit=20&type=SWAP`
    );
    if (!res.ok) return { whalePresent: false, kolPresent: false, bundlePct: 0 };
    const txs = await res.json() as any[];

    const recentBig = txs.filter((tx: any) => {
      const age   = Date.now() - (tx.timestamp ?? 0) * 1000;
      const value = (tx.tokenTransfers ?? []).reduce((s: number, t: any) => {
        let amount = t.tokenAmount ?? 0;
        if (decimals > 0) amount = amount / Math.pow(10, decimals);
        return s + amount;
      }, 0);
      return age < 3600000 && value > 1; // > 1 token in last hour
    });

    return {
      whalePresent: recentBig.length > 2,
      kolPresent:   false,
      bundlePct:    0,
    };
  } catch {
    return { whalePresent: false, kolPresent: false, bundlePct: 0 };
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

    const [bird, whale] = await Promise.all([
      enrichWithBirdeye(http, mint),
      checkWhaleActivity(http, mint),
    ]);

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
      bundlePct:     whale.bundlePct,
      isWash:        false,
      isRugpull:     p.is_blacklisted ?? false,
      kolPresent:    whale.kolPresent,
      whalePresent:  whale.whalePresent,
      deployerAddress: '',
      novaScore:     0,
      riskLevel:     'MEDIUM',
      recommendation: '',
    };

    // Compute composite score
    candidate.novaScore     = computeNovaScore(candidate);
    candidate.riskLevel     = getRiskLevel(candidate);
    candidate.recommendation = candidate.novaScore >= 65
      ? `Deploy ${config.lpStrategy} strategy. High fee efficiency.`
      : candidate.novaScore >= 45
      ? 'Monitor — marginal opportunity, wait for better entry.'
      : 'Skip — does not meet quality threshold.';

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

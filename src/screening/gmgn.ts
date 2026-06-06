import { config } from '../config';
import { logger } from '../utils/logger';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────

export interface GmgnTrendingToken {
  address:        string;
  symbol:         string;
  name:           string;
  volume24h:      number;
  marketCap:      number;
  holderCount:    number;
  priceChange24h: number;
  swapCount24h:   number;
  liquidity:      number;
}

export interface GmgnTokenInfo {
  rugRatio:              number;
  insiderHoldRate:       number;
  sniperCount:           number;
  smartDegenCount:       number;
  bundlerVolumeRate:     number;
  ratTraderVolumeRate:   number;
  mintDisabled:          boolean;
  top10HolderRate:       number;
  burnRatio:             number;
}

// ── Rate limiter (1 req/sec) ──────────────────────────────────

let lastRequestAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastRequestAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

// ── Execute gmgn-cli command ──────────────────────────────────

async function runGmgnCli(args: string[]): Promise<any> {
  if (!config.gmgnApiKey) return null;

  await rateLimit();

  try {
    const env = { ...process.env, GMGN_API_KEY: config.gmgnApiKey };
    const { stdout } = await execFileAsync('gmgn-cli', args, {
      env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err: any) {
    logger.warn('gmgn-cli failed', { args: args.join(' '), err: err.message });
    return null;
  }
}

// ── Fetch trending tokens ─────────────────────────────────────

export async function fetchGmgnTrending(
  _http: typeof fetch,
  limit = 50,
): Promise<GmgnTrendingToken[]> {
  if (!config.gmgnApiKey) return [];

  const data = await runGmgnCli([
    'market', 'trending',
    '--chain', 'sol',
    '--interval', '1h',
    '--order-by', 'volume',
    '--limit', String(limit),
    '--raw',
  ]);

  if (!data?.data?.rank) {
    logger.warn('GMGN trending: no data');
    return [];
  }

  const tokens: GmgnTrendingToken[] = data.data.rank.map((t: any) => ({
    address:        t.address ?? '',
    symbol:         t.symbol ?? '',
    name:           t.name ?? '',
    volume24h:      parseFloat(t.volume ?? '0'),
    marketCap:      parseFloat(t.market_cap ?? '0'),
    holderCount:    parseInt(t.holder_count ?? '0'),
    priceChange24h: parseFloat(t.change24h ?? t.price_change_percent ?? '0'),
    swapCount24h:   parseInt(t.swaps ?? '0'),
    liquidity:      parseFloat(t.liquidity ?? '0'),
  }));

  logger.info(`GMGN: got ${tokens.length} trending tokens`, {
    top: tokens.slice(0, 3).map(t => `${t.symbol}($${(t.volume24h / 1000).toFixed(0)}k)`).join(', '),
  });

  return tokens.filter(t => t.address && t.symbol);
}

// ── Fetch token risk info ─────────────────────────────────────

export async function fetchGmgnTokenInfo(
  _http: typeof fetch,
  address: string,
): Promise<GmgnTokenInfo | null> {
  if (!config.gmgnApiKey) return null;

  const data = await runGmgnCli([
    'token', 'info',
    '--chain', 'sol',
    '--address', address,
    '--raw',
  ]);

  if (!data?.data) return null;

  const token = data.data;
  const stat = token.stat ?? {};
  const security = token.security ?? {};

  return {
    rugRatio:              parseFloat(stat.rug_ratio ?? security.rug_ratio ?? '0'),
    insiderHoldRate:       parseFloat(stat.suspected_insider_hold_rate ?? '0'),
    sniperCount:           parseInt(stat.sniper_count ?? '0'),
    smartDegenCount:       parseInt(stat.smart_degen_count ?? '0'),
    bundlerVolumeRate:     parseFloat(stat.bundler_trader_amount_rate ?? '0'),
    ratTraderVolumeRate:   parseFloat(stat.rat_trader_amount_rate ?? '0'),
    mintDisabled:          security.renounced_mint === '1' || security.renounced_mint === 1,
    top10HolderRate:       parseFloat(stat.top_10_holder_rate ?? '0'),
    burnRatio:             parseFloat(security.burn_ratio ?? '0'),
  };
}

import dotenv from 'dotenv';
dotenv.config();

function req(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}
function opt(k: string, d: string): string { return process.env[k] ?? d; }
function num(k: string, d: number): number { return parseFloat(process.env[k] ?? String(d)); }

export type LPStrategy = 'spot' | 'curve' | 'bid_ask' | 'auto';

export const config = {
  // Wallet
  walletPrivateKey: req('WALLET_PRIVATE_KEY'),
  rpcUrl: opt('SOLANA_RPC', 'https://api.mainnet-beta.solana.com'),

  // APIs
  openrouterKey: req('OPENROUTER_API_KEY'),
  heliusKey:     opt('HELIUS_API_KEY', ''),
  birdeyeKey:    opt('BIRDEYE_API_KEY', ''),
  llmModel:      opt('LLM_MODEL', 'openai/gpt-4o'),
  llmBaseUrl:    opt('LLM_BASE_URL', 'https://openrouter.ai/api/v1'),

  // Telegram
  telegramToken:  req('TELEGRAM_BOT_TOKEN'),
  telegramChatId: req('TELEGRAM_CHAT_ID'),

  // Capital & risk
  totalCapitalSol:  num('TOTAL_CAPITAL_SOL', 2.0),
  maxPositionSol:   num('MAX_POSITION_SOL', 0.4),
  maxPositions:     parseInt(opt('MAX_POSITIONS', '5')),
  minPositionSol:   num('MIN_POSITION_SOL', 0.05),
  stopLossPct:      num('STOP_LOSS_PCT', 0.15),
  takeProfitPct:    num('TAKE_PROFIT_PCT', 0.25),
  maxDrawdownPct:   num('MAX_DRAWDOWN_PCT', 0.30),

  // Screening
  screening: {
    minTvl:           num('MIN_TVL', 8000),
    maxTvl:           num('MAX_TVL', 500000),
    minFeeTvlRatio:   num('MIN_FEE_TVL_RATIO', 0.05),
    minVolume24h:     num('MIN_VOLUME_24H', 20000),
    minHolders:       parseInt(opt('MIN_HOLDERS', '100')),
    maxMcap:          num('MAX_MCAP', 5000000),
    minOrganicScore:  num('MIN_ORGANIC_SCORE', 50),
    minBinStep:       parseInt(opt('MIN_BIN_STEP', '50')),
    maxBinStep:       parseInt(opt('MAX_BIN_STEP', '200')),
  },

  // Timing
  hunterIntervalMin:  parseInt(opt('HUNTER_INTERVAL_MIN', '15')),
  healerIntervalMin:  parseInt(opt('HEALER_INTERVAL_MIN', '5')),
  dailyReportHourUtc: parseInt(opt('DAILY_REPORT_HOUR_UTC', '13')),

  // Strategy
  lpStrategy: opt('LP_STRATEGY', 'auto') as LPStrategy,
  binRange:   parseInt(opt('BIN_RANGE', '69')),
  slippageBps: parseInt(opt('SLIPPAGE_BPS', '200')),

  // Mode
  dryRun:    opt('DRY_RUN', '') === 'true',
  logLevel:  opt('LOG_LEVEL', 'info'),
  dbPath:    opt('DB_PATH', './data/nova.db'),

  // Misc
  usdToIdr: num('USD_TO_IDR', 15000),
} as const;

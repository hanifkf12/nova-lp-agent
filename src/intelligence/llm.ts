import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getLessons, buildPerformanceMemory } from '../db';
import { PoolCandidate } from '../screening/hunter';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: config.anthropicKey });

export type AgentRole = 'HUNTER' | 'HEALER' | 'GENERAL';

export interface DeployDecision {
  action:         'DEPLOY' | 'SKIP';
  strategy:       'spot' | 'curve' | 'bid_ask';
  solAmount:      number;
  binRange:       number;
  confidence:     number;
  reasoning:      string;
  learnedFrom:    string | null;
  warnings:       string[];
}

export interface HealDecision {
  action:     'STAY' | 'CLOSE' | 'REDEPLOY' | 'CLAIM_FEES';
  reasoning:  string;
  urgency:    'LOW' | 'MEDIUM' | 'HIGH';
  newStrategy?: string;
}

// ── HUNTER: apakah deploy di pool ini? ────────────────────────

export async function askHunter(
  candidate:   PoolCandidate,
  openCount:   number,
  solBalance:  number,
): Promise<DeployDecision> {

  const lessons   = getLessons('HUNTER', 8);
  const perf      = buildPerformanceMemory();

  const prompt = `
Kamu adalah HUNTER agent yang mencari pool Meteora DLMM terbaik untuk LP.
Putuskan apakah deploy likuiditas ke pool ini menguntungkan.

=== POOL CANDIDATE ===
Symbol        : ${candidate.tokenSymbol}
Nova Score    : ${candidate.novaScore.toFixed(1)}/100
Risk Level    : ${candidate.riskLevel}
Pool Address  : ${candidate.poolAddress}

Fee/TVL Ratio : ${(candidate.feeTvlRatio * 100).toFixed(2)}% 
Volume 24h    : $${candidate.volume24hUsd.toLocaleString()}
TVL           : $${candidate.tvlUsd.toLocaleString()}
Organic Score : ${candidate.organicScore.toFixed(0)}/100
Holders       : ${candidate.holderCount.toLocaleString()}
Market Cap    : $${candidate.mcapUsd.toLocaleString()}
Bin Step      : ${candidate.binStep}
Price Change 24h: ${candidate.priceChange24h.toFixed(2)}%
Whale Present : ${candidate.whalePresent ? 'YES' : 'No'}
KOL Present   : ${candidate.kolPresent ? 'YES' : 'No'}
Bundle %      : ${candidate.bundlePct.toFixed(1)}%

=== PORTFOLIO ===
Open Positions: ${openCount}/${config.maxPositions}
SOL Balance   : ${solBalance.toFixed(4)} SOL
Max per pos   : ${config.maxPositionSol} SOL

=== HISTORICAL PERFORMANCE ===
Total closed  : ${perf.stats?.total ?? 0} | Win rate: ${perf.winRatePct}%
Avg fee APR   : ${perf.stats?.avg_fee_apr ?? 0}%
${perf.recentTrades}

=== LESSONS FROM PAST TRADES ===
${lessons.length > 0 ? lessons.map((l, i) => `${i+1}. ${l}`).join('\n') : 'Belum ada lessons.'}

=== STRATEGI ===
- SPOT: distribusi merata, cocok untuk trending market
- CURVE: konsentrasi di harga sekarang, cocok untuk sideways tight
- BID_ASK: konsentrasi di edges, cocok untuk volatile / DCA

ATURAN:
- Fee/TVL ratio < 5% → biasanya SKIP
- Nova score < 50 → SKIP
- Bundle % > 40% → SKIP (manipulasi)
- Risk HIGH → hanya deploy kalau confidence > 0.85
- Max deploy = min(${config.maxPositionSol} SOL, 20% dari total capital)

Respond HANYA JSON:
{
  "action": "DEPLOY" | "SKIP",
  "strategy": "spot" | "curve" | "bid_ask",
  "solAmount": number,
  "binRange": number,
  "confidence": 0.0-1.0,
  "reasoning": "max 2 kalimat",
  "learnedFrom": "lesson relevan atau null",
  "warnings": ["warning1"]
}`;

  const response = await anthropic.messages.create({
    model:      config.llmModel,
    max_tokens: 400,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw     = (response.content[0] as any).text as string;
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const decision = JSON.parse(cleaned) as DeployDecision;

  logger.info('Hunter LLM decision', {
    symbol:     candidate.tokenSymbol,
    action:     decision.action,
    confidence: decision.confidence,
    strategy:   decision.strategy,
  });

  return decision;
}

// ── HEALER: apakah stay, close, atau redeploy? ─────────────────

export async function askHealer(position: any, liveData: {
  currentPrice:  number;
  feesEarnedSol: number;
  isInRange:     boolean;
  pnlPct:        number;
  hoursOpen:     number;
  currentTvl:    number;
  currentVolume: number;
  feeTvlRatio:   number;
}): Promise<HealDecision> {

  const lessons = getLessons('HEALER', 6);

  const prompt = `
Kamu adalah HEALER agent yang mengelola posisi LP aktif.
Evaluasi posisi ini dan putuskan: STAY, CLOSE, CLAIM_FEES, atau REDEPLOY.

=== POSISI AKTIF ===
Token       : ${position.token_symbol}
Pool        : ${position.pool_address}
SOL deployed: ${position.sol_deployed} SOL
Strategy    : ${position.strategy}
Buka        : ${new Date(position.opened_at).toLocaleString('id-ID')}
Durasi      : ${liveData.hoursOpen.toFixed(1)} jam

=== STATUS LIVE ===
In Range    : ${liveData.isInRange ? 'YES ✓' : 'NO — tidak earning fee'}
Current PnL : ${liveData.pnlPct.toFixed(2)}%
Fees earned : ${liveData.feesEarnedSol.toFixed(6)} SOL
Current price: $${liveData.currentPrice.toFixed(6)}

=== POOL HEALTH ===
TVL saat ini  : $${liveData.currentTvl.toLocaleString()}
Volume 24h    : $${liveData.currentVolume.toLocaleString()}
Fee/TVL ratio : ${(liveData.feeTvlRatio * 100).toFixed(2)}%

=== RISK THRESHOLDS ===
Stop loss   : ${(config.stopLossPct * 100).toFixed(0)}%
Take profit : ${(config.takeProfitPct * 100).toFixed(0)}%

=== LESSONS ===
${lessons.length > 0 ? lessons.map((l, i) => `${i+1}. ${l}`).join('\n') : 'Belum ada lessons.'}

ATURAN KETAT:
- PnL < -${(config.stopLossPct * 100).toFixed(0)}% → CLOSE (stop loss)
- PnL > +${(config.takeProfitPct * 100).toFixed(0)}% → CLOSE (take profit)
- Out of range > 2 jam → REDEPLOY ke range baru
- Fee/TVL ratio turun < 2% → pertimbangkan CLOSE
- Fees cukup besar (> 0.01 SOL) dan in range → CLAIM_FEES lalu STAY

Respond HANYA JSON:
{
  "action": "STAY" | "CLOSE" | "REDEPLOY" | "CLAIM_FEES",
  "reasoning": "max 2 kalimat",
  "urgency": "LOW" | "MEDIUM" | "HIGH",
  "newStrategy": "spot|curve|bid_ask jika REDEPLOY, else null"
}`;

  const response = await anthropic.messages.create({
    model:      config.llmModel,
    max_tokens: 300,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw     = (response.content[0] as any).text as string;
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const decision = JSON.parse(cleaned) as HealDecision;

  logger.info('Healer LLM decision', {
    symbol:  position.token_symbol,
    action:  decision.action,
    urgency: decision.urgency,
  });

  return decision;
}

// ── Post-close: derive lessons ─────────────────────────────────

export async function deriveLesson(position: any): Promise<string> {
  const prompt = `
Analisis posisi LP ini dan tulis 1 lesson konkret untuk agent di masa depan.

Token: ${position.token_symbol}
Strategy: ${position.strategy}
PnL: ${position.pnl_pct?.toFixed(2)}%
Fee APR: ${position.fee_apr_pct?.toFixed(1)}%
Exit reason: ${position.exit_reason}
Time in range: ${position.time_in_range_pct?.toFixed(1)}%
Fee/TVL at entry: ${(position.fee_tvl_ratio * 100)?.toFixed(2)}%
Holder count: ${position.holder_count}
Was whale present: ${position.whale_present ? 'yes' : 'no'}

Tulis SATU kalimat lesson yang actionable dan spesifik.
Contoh format: "Kalau [kondisi X], maka [aksi Y] karena [alasan Z]"
Respond HANYA dengan teks lesson, tanpa JSON atau format lain.`;

  const response = await anthropic.messages.create({
    model:      config.llmModel,
    max_tokens: 150,
    messages:   [{ role: 'user', content: prompt }],
  });

  return (response.content[0] as any).text.trim();
}

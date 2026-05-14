import { config } from '../config';
import { getLessons, buildPerformanceMemory } from '../db';
import { PoolCandidate } from '../screening/hunter';
import { logger } from '../utils/logger';

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

async function llmCall(prompt: string, maxTokens = 1200): Promise<string> {
  const http = (await import('node-fetch')).default as unknown as typeof fetch;
  const res = await http(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openrouterKey}`,
      'HTTP-Referer': 'https://nova-lp-agent.local',
      'X-Title': 'Nova LP Agent',
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? '';
}

function extractJson(raw: string): string {
  let cleaned = raw.replace(/```json|```/g, '').trim();
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  } else if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

async function parseJSONWithRetry<T>(rawText: string, maxRetries = 2): Promise<T> {
  let text = rawText;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return JSON.parse(extractJson(text)) as T;
    } catch (firstErr) {
      if (attempt === maxRetries) throw firstErr;
      const fixPrompt = `You returned invalid JSON. Fix it so JSON.parse succeeds. Return ONLY valid JSON, no markdown, no explanation:\n\n${text}`;
      text = await llmCall(fixPrompt, 400);
    }
  }
  throw new Error('JSON parsing failed after retries');
}

export async function askHunterBatch(
  candidates:  PoolCandidate[],
  openCount:   number,
  solBalance:  number,
): Promise<DeployDecision[]> {

  const lessons   = getLessons('HUNTER', 8);
  const perf      = buildPerformanceMemory();

  const candidateBlocks = candidates.map((c, i) => `
=== CANDIDATE ${i + 1} ===
Symbol        : ${c.tokenSymbol}
Nova Score    : ${c.novaScore.toFixed(1)}/100
Risk Level    : ${c.riskLevel}
Pool Address  : ${c.poolAddress}
Fee/TVL Ratio : ${(c.feeTvlRatio * 100).toFixed(2)}% 
Volume 24h    : $${c.volume24hUsd.toLocaleString()}
TVL           : $${c.tvlUsd.toLocaleString()}
Organic Score : ${c.organicScore.toFixed(0)}/100
Holders       : ${c.holderCount.toLocaleString()}
Market Cap    : $${c.mcapUsd.toLocaleString()}
Bin Step      : ${c.binStep}
Price Change 24h: ${c.priceChange24h.toFixed(2)}%
Whale Present : ${c.whalePresent ? 'YES' : 'No'}
KOL Present   : ${c.kolPresent ? 'YES' : 'No'}
Bundle %      : ${c.bundlePct.toFixed(1)}%
`).join('');

  const prompt = `
Kamu adalah HUNTER agent yang mencari pool Meteora DLMM terbaik untuk LP.
Evaluasi ${candidates.length} kandidat pool dan putuskan untuk masing-masing apakah deploy likuiditas menguntungkan.

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

${candidateBlocks}

Respond HANYA JSON array dengan ${candidates.length} entry:
[
  {
    "action": "DEPLOY" | "SKIP",
    "strategy": "spot" | "curve" | "bid_ask",
    "solAmount": number,
    "binRange": number,
    "confidence": 0.0-1.0,
    "reasoning": "max 2 kalimat",
    "learnedFrom": "lesson relevan atau null",
    "warnings": ["warning1"]
  }
]`;

  const raw = await llmCall(prompt, 1200);
  const decisions = await parseJSONWithRetry<DeployDecision[]>(raw);

  for (let i = 0; i < decisions.length && i < candidates.length; i++) {
    logger.info('Hunter LLM decision', {
      symbol:     candidates[i].tokenSymbol,
      action:     decisions[i].action,
      confidence: decisions[i].confidence,
      strategy:   decisions[i].strategy,
    });
  }

  return decisions;
}

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

  const raw = await llmCall(prompt, 300);
  return parseJSONWithRetry<HealDecision>(raw);
}

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

  const raw = await llmCall(prompt, 150);
  return raw.trim();
}

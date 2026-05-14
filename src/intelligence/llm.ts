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
  action:      'STAY' | 'CLOSE' | 'REDEPLOY' | 'CLAIM_FEES';
  reasoning:   string;
  urgency:     'LOW' | 'MEDIUM' | 'HIGH';
  newStrategy: 'spot' | 'curve' | 'bid_ask' | null;
}

// ── OpenRouter call with Anthropic prompt caching + tool use ───
//
// Content array elements may include `cache_control: { type: 'ephemeral' }`
// — OpenRouter forwards this to Anthropic, marking all prior content as a
// cacheable prefix (5-minute TTL by default). Effective when the same system
// block repeats across calls in a single cycle (e.g. parallel healer over N
// positions, or hunter batch across many candidates).

type ContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface LlmOptions {
  model:        string;
  systemBlocks: ContentBlock[];          // static prefix — last block gets cache_control
  userBlocks:   ContentBlock[];          // dynamic per-call content
  tools?:       ToolDef[];
  toolChoice?:  string;                  // force a specific tool by name
  maxTokens?:   number;
}

async function llmCall(opts: LlmOptions): Promise<{
  text:     string;
  toolArgs: Record<string, unknown> | null;
}> {
  const http = (await import('node-fetch')).default as unknown as typeof fetch;

  const body: Record<string, unknown> = {
    model:      opts.model,
    max_tokens: opts.maxTokens ?? 1200,
    messages: [
      { role: 'system', content: opts.systemBlocks },
      { role: 'user',   content: opts.userBlocks   },
    ],
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    if (opts.toolChoice) {
      body.tool_choice = {
        type: 'function',
        function: { name: opts.toolChoice },
      };
    }
  }

  const res = await http(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.openrouterKey}`,
      'HTTP-Referer':  'https://nova-lp-agent.local',
      'X-Title':       'Nova LP Agent',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${await res.text()}`);
  }

  const data    = await res.json() as any;
  const choice  = data.choices?.[0]?.message;
  const text    = typeof choice?.content === 'string' ? choice.content : '';
  const tcalls  = choice?.tool_calls ?? [];
  let toolArgs: Record<string, unknown> | null = null;
  if (tcalls.length > 0) {
    const raw = tcalls[0]?.function?.arguments ?? '';
    try {
      toolArgs = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      logger.warn('Tool args JSON parse failed', { raw, err });
    }
  }

  const usage = data.usage ?? {};
  if (usage.prompt_tokens_details?.cached_tokens > 0) {
    logger.debug('LLM cache hit', {
      cached:  usage.prompt_tokens_details.cached_tokens,
      prompt:  usage.prompt_tokens,
      model:   opts.model,
    });
  }

  return { text, toolArgs };
}

// ── Tool schemas ───────────────────────────────────────────────

const hunterTool: ToolDef = {
  type: 'function',
  function: {
    name: 'submit_deploy_decisions',
    description: 'Submit a deploy-or-skip decision for each candidate pool. Order MUST match the order of CANDIDATE blocks in the prompt.',
    parameters: {
      type: 'object',
      properties: {
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action:      { type: 'string', enum: ['DEPLOY', 'SKIP'] },
              strategy:    { type: 'string', enum: ['spot', 'curve', 'bid_ask'] },
              solAmount:   { type: 'number', minimum: 0 },
              binRange:    { type: 'integer', minimum: 10, maximum: 200 },
              confidence:  { type: 'number', minimum: 0, maximum: 1 },
              reasoning:   { type: 'string', maxLength: 280 },
              learnedFrom: { type: ['string', 'null'] },
              warnings:    { type: 'array', items: { type: 'string' } },
            },
            required: ['action', 'strategy', 'solAmount', 'binRange', 'confidence', 'reasoning', 'warnings'],
          },
        },
      },
      required: ['decisions'],
    },
  },
};

const healerTool: ToolDef = {
  type: 'function',
  function: {
    name: 'submit_heal_decision',
    description: 'Submit one action decision for the active LP position.',
    parameters: {
      type: 'object',
      properties: {
        action:      { type: 'string', enum: ['STAY', 'CLOSE', 'REDEPLOY', 'CLAIM_FEES'] },
        reasoning:   { type: 'string', maxLength: 280 },
        urgency:     { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        newStrategy: { type: ['string', 'null'], enum: ['spot', 'curve', 'bid_ask', null] },
      },
      required: ['action', 'reasoning', 'urgency'],
    },
  },
};

// ── Static rule blocks (cacheable) ─────────────────────────────

function hunterStaticRules(): string {
  return `You are the HUNTER agent — finding the best Meteora DLMM pools for single-sided LP.

=== STRATEGIES ===
- SPOT: uniform distribution across bins, good for trending markets with momentum
- CURVE: concentrated at current price, good for tight sideways action, highest fees but easiest to go out-of-range
- BID_ASK: concentrated at the edges, good for volatile pools / passive DCA

=== HARD RULES ===
- Fee/TVL ratio < 5% → usually SKIP (fee inefficiency)
- Nova score < 50 → SKIP
- Bundle % > 40% → SKIP (supply manipulation)
- Risk HIGH → only deploy if confidence > 0.85 and there's a relevant lesson
- Max deploy per position = min(${config.maxPositionSol} SOL, 20% of total capital)
- Prefer fresh pools (high volume, growing holders) over stale pools

Output via tool call \`submit_deploy_decisions\`. The order of decisions MUST match the order of CANDIDATE blocks in the user message.`;
}

function healerStaticRules(): string {
  return `You are the HEALER agent — managing active DLMM LP positions.

=== DECISIONS ===
- STAY: position is healthy, let it keep earning
- CLAIM_FEES: harvest accrued fees but keep holding the position
- CLOSE: close the position (stop loss / take profit / pool death)
- REDEPLOY: close and re-deploy to a new range (out of range for too long)

=== HARD RULES ===
- PnL < -${(config.stopLossPct * 100).toFixed(0)}% (includes IL) → CLOSE (stop loss)
- PnL > +${(config.takeProfitPct * 100).toFixed(0)}% → CLOSE (take profit)
- Out of range > 2 hours → REDEPLOY to a new range around the current price
- Fee/TVL ratio dropped < 2% while in-range → consider CLOSE (pool dying)
- Fees > 0.01 SOL accumulated and in-range → CLAIM_FEES then STAY
- Position open < 1 hour → bias toward STAY unless stop-loss triggers

Output via tool call \`submit_heal_decision\`.`;
}

// ── HUNTER ─────────────────────────────────────────────────────

export async function askHunterBatch(
  candidates: PoolCandidate[],
  openCount:  number,
  solBalance: number,
): Promise<DeployDecision[]> {
  if (candidates.length === 0) return [];

  const lessons = getLessons('HUNTER', 8);
  const perf    = buildPerformanceMemory();

  // Static prefix gets cache_control — same across all hunter cycles
  // within the 5-min ephemeral TTL window.
  const systemBlocks: ContentBlock[] = [
    { type: 'text', text: hunterStaticRules(), cache_control: { type: 'ephemeral' } },
  ];

  const userBlocks: ContentBlock[] = [
    {
      type: 'text',
      text:
`=== PORTFOLIO ===
Open Positions : ${openCount}/${config.maxPositions}
SOL Balance    : ${solBalance.toFixed(4)} SOL
Max per pos    : ${config.maxPositionSol} SOL

=== HISTORICAL PERFORMANCE ===
Total closed   : ${perf.stats?.total ?? 0} | Win rate: ${perf.winRatePct}%
Avg fee APR    : ${perf.stats?.avg_fee_apr ?? 0}%
Recent:
${perf.recentTrades}

=== LESSONS FROM PAST TRADES ===
${lessons.length > 0 ? lessons.map((l, i) => `${i + 1}. ${l}`).join('\n') : 'No lessons yet.'}

${candidates.map((c, i) => `
=== CANDIDATE ${i + 1} ===
Symbol         : ${c.tokenSymbol}
Nova Score     : ${c.novaScore.toFixed(1)}/100
Risk Level     : ${c.riskLevel}
Pool Address   : ${c.poolAddress}
Fee/TVL Ratio  : ${(c.feeTvlRatio * 100).toFixed(2)}%
Volume 24h     : $${c.volume24hUsd.toLocaleString()}
TVL            : $${c.tvlUsd.toLocaleString()}
Organic Score  : ${c.organicScore.toFixed(0)}/100
Holders        : ${c.holderCount.toLocaleString()}
Market Cap     : $${c.mcapUsd.toLocaleString()}
Bin Step       : ${c.binStep}
Price Change 24h: ${c.priceChange24h.toFixed(2)}%
Whale Present  : ${c.whalePresent ? 'YES' : 'No'}
KOL Present    : ${c.kolPresent ? 'YES' : 'No'}
Bundle %       : ${c.bundlePct.toFixed(1)}%
`).join('')}`,
    },
  ];

  const { toolArgs } = await llmCall({
    model:        config.hunterModel,
    systemBlocks,
    userBlocks,
    tools:        [hunterTool],
    toolChoice:   hunterTool.function.name,
    maxTokens:    1500,
  });

  const decisions = (toolArgs?.decisions ?? []) as DeployDecision[];
  if (!Array.isArray(decisions) || decisions.length === 0) {
    logger.error('Hunter LLM returned no decisions', { toolArgs });
    return candidates.map(() => ({
      action: 'SKIP', strategy: 'spot', solAmount: 0, binRange: config.binRange,
      confidence: 0, reasoning: 'LLM returned no decisions', learnedFrom: null, warnings: [],
    }));
  }

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

// ── HEALER ─────────────────────────────────────────────────────

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

  const systemBlocks: ContentBlock[] = [
    { type: 'text', text: healerStaticRules(), cache_control: { type: 'ephemeral' } },
  ];

  const userBlocks: ContentBlock[] = [
    {
      type: 'text',
      text:
`=== ACTIVE POSITION ===
Token        : ${position.token_symbol}
Pool         : ${position.pool_address}
SOL deployed : ${position.sol_deployed} SOL
Strategy     : ${position.strategy}
Opened       : ${new Date(position.opened_at).toISOString()}
Duration     : ${liveData.hoursOpen.toFixed(1)} hours

=== LIVE STATUS ===
In Range     : ${liveData.isInRange ? 'YES' : 'NO — not earning fees'}
PnL (incl IL): ${liveData.pnlPct.toFixed(2)}%
Fees earned  : ${liveData.feesEarnedSol.toFixed(6)} SOL
Current price: ${liveData.currentPrice.toFixed(8)}

=== POOL HEALTH ===
Current TVL  : $${liveData.currentTvl.toLocaleString()}
Volume 24h   : $${liveData.currentVolume.toLocaleString()}
Fee/TVL ratio: ${(liveData.feeTvlRatio * 100).toFixed(2)}%

=== LESSONS ===
${lessons.length > 0 ? lessons.map((l, i) => `${i + 1}. ${l}`).join('\n') : 'No lessons yet.'}`,
    },
  ];

  const { toolArgs } = await llmCall({
    model:      config.healerModel,
    systemBlocks,
    userBlocks,
    tools:      [healerTool],
    toolChoice: healerTool.function.name,
    maxTokens:  400,
  });

  if (!toolArgs) {
    logger.error('Healer LLM returned no tool call');
    return { action: 'STAY', reasoning: 'LLM no decision — defaulting STAY', urgency: 'LOW', newStrategy: null };
  }

  return toolArgs as unknown as HealDecision;
}

// ── deriveLesson ───────────────────────────────────────────────

export async function deriveLesson(position: any): Promise<string> {
  const systemBlocks: ContentBlock[] = [
    {
      type: 'text',
      text:
`You are the lesson-distiller. Analyze ONE closed LP position and write ONE sentence of actionable guidance for the agent's future decisions.

Required format: "If [concrete condition], then [specific action] because [reason/mechanism]"

Rules:
- One sentence only, max 200 characters
- Condition must be measurable (specific numbers from the data, not vague)
- Action must be actionable (DEPLOY/SKIP/CLOSE/REDEPLOY/sizing/strategy)
- No preamble, no quotes, no JSON — reply with the lesson sentence directly`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const userBlocks: ContentBlock[] = [
    {
      type: 'text',
      text:
`Token        : ${position.token_symbol}
Strategy     : ${position.strategy}
PnL          : ${position.pnl_pct?.toFixed(2)}%
Fee APR      : ${position.fee_apr_pct?.toFixed(1)}%
Exit reason  : ${position.exit_reason}
Time in range: ${position.time_in_range_pct?.toFixed(1)}%
Fee/TVL entry: ${(position.fee_tvl_ratio * 100)?.toFixed(2)}%
Holders      : ${position.holder_count}
Whale present: ${position.whale_present ? 'yes' : 'no'}
Bundle %     : ${position.bundle_pct?.toFixed(1) ?? '?'}%
TVL entry    : $${position.tvl_usd?.toLocaleString() ?? '?'}`,
    },
  ];

  const { text } = await llmCall({
    model:     config.lessonModel,
    systemBlocks,
    userBlocks,
    maxTokens: 200,
  });

  return text.trim().replace(/^["']|["']$/g, '');
}

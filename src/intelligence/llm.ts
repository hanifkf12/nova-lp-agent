import { config } from '../config';
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

const MAX_RETRIES   = 3;
const RETRY_BASE_MS  = 2000;

const isAnthropic = (model: string) =>
  model.startsWith('anthropic/') || model.startsWith('claude-');

// OpenRouter accepts a `provider` routing field and Anthropic-style structured
// content blocks with `cache_control`. Other gateways (sumopod, OpenAI direct,
// Groq, etc.) reject both. We detect OpenRouter by base URL.
const isOpenRouter = () => config.llmBaseUrl.includes('openrouter.ai');

function sanitizeBlocks(blocks: ContentBlock[], model: string): ContentBlock[] {
  // Strip cache_control unless we're going through OpenRouter to an Anthropic
  // model — that's the only path that understands it.
  if (isOpenRouter() && isAnthropic(model)) return blocks;
  return blocks.map(({ cache_control, ...rest }) => rest);
}

// Some gateways (sumopod via litellm) want `content: "string"` for messages
// instead of `content: [{type:'text', text:'...'}]`. Collapse blocks to a
// single string when we're not on a structured-content-friendly provider.
function blocksToContent(blocks: ContentBlock[]): string | ContentBlock[] {
  if (isOpenRouter()) return blocks;
  return blocks.map(b => b.text).join('\n\n');
}

async function llmCall(opts: LlmOptions): Promise<{
  text:     string;
  toolArgs: Record<string, unknown> | null;
}> {
  const http = (await import('node-fetch')).default as unknown as typeof fetch;

  const makeBody = (): Record<string, unknown> => {
    const isAnt = isAnthropic(opts.model);
    const sysBlocks = sanitizeBlocks(opts.systemBlocks, opts.model);
    const usrBlocks = sanitizeBlocks(opts.userBlocks, opts.model);

    const body: Record<string, unknown> = {
      model:      opts.model,
      max_tokens: opts.maxTokens ?? 1200,
      messages: [
        { role: 'system', content: blocksToContent(sysBlocks) },
        { role: 'user',   content: blocksToContent(usrBlocks) },
      ],
    };

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      if (opts.toolChoice) {
        // OpenAI tool_choice shape — OpenRouter normalizes to each provider's
        // native format. Avoids Bedrock's strict parser rejecting the
        // Anthropic-native `type: 'tool'` form when OpenRouter doesn't
        // translate it. (`type: 'tool_use'` was wrong outright — that's the
        // response block type, not a request field.)
        body.tool_choice = { type: 'function', function: { name: opts.toolChoice } };
      }
    }

    // Force OpenRouter to pick a provider that actually supports the
    // parameters we send (tools, tool_choice). Without this, Bedrock can
    // be picked and reject the call. Also prefer Anthropic direct first
    // for Claude models — it's most permissive on tool-use requests.
    // Skipped on non-OpenRouter gateways (they reject unknown fields).
    if (isOpenRouter()) {
      body.provider = {
        require_parameters: true,
        ...(isAnt ? { order: ['anthropic', 'amazon-bedrock'], allow_fallbacks: true } : {}),
      };
    }

    return body;
  };

  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await http(`${config.llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${config.openrouterKey}`,
          'HTTP-Referer':  'https://nova-lp-agent.local',
          'X-Title':       'Nova LP Agent',
        },
        body: JSON.stringify(makeBody()),
      });

      const respText = await res.text();

      if (!res.ok) {
        throw new Error(`LLM ${res.status}: ${respText.slice(0, 200)}`);
      }

      const data    = JSON.parse(respText);
      const choice  = data.choices?.[0]?.message;
      const text    = typeof choice?.content === 'string' ? choice.content : '';
      const tcalls  = choice?.tool_calls ?? [];
      let toolArgs: Record<string, unknown> | null = null;
      if (tcalls.length > 0) {
        const raw = tcalls[0]?.function?.arguments ?? '';
        try {
          toolArgs = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (err) {
          logger.warn('Tool args JSON parse failed', { raw: String(raw).slice(0, 200) });
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

    } catch (err) {
      lastErr = err as Error;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(`LLM attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms`, {
          model: opts.model,
          err: (err as Error).message.slice(0, 120),
        });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastErr ?? new Error('LLM call failed after retries');
}

// ── Tool schemas ───────────────────────────────────────────────

const healerTool: ToolDef = {
  type: 'function',
  function: {
    name: 'submit_heal_decision',
    description: 'Submit one action decision for the active LP position.',
    parameters: {
      type: 'object',
      properties: {
        action:      { type: 'string', enum: ['STAY', 'CLOSE', 'CLAIM_FEES'] },
        reasoning:   { type: 'string', maxLength: 280 },
        urgency:     { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        newStrategy: { type: ['string', 'null'], enum: ['spot', 'curve', 'bid_ask', null] },
      },
      required: ['action', 'reasoning', 'urgency'],
    },
  },
};

// ── Static rule blocks (cacheable) ─────────────────────────────

function healerStaticRules(): string {
  return `You are the HEALER agent — managing active DLMM LP positions.

=== DECISIONS ===
- STAY: position is healthy, let it keep earning
- CLAIM_FEES: harvest accrued fees but keep holding the position
- CLOSE: close the position (stop loss / take profit / pool death / out of range too long)

=== HARD RULES ===
- PnL below -${(config.stopLossPct * 100).toFixed(0)} percent (includes IL) → CLOSE (stop loss)
- PnL above +${(config.takeProfitPct * 100).toFixed(0)} percent → CLOSE (take profit)
- Out of range more than 4 hours → CLOSE (pool has shifted, cut losses)

Realizable value vs mid-price PnL:
- Two PnL numbers are shown: PnL at mid-price (optimistic) and PnL after close slippage (realistic)
- If close slippage is above ${(config.maxCloseSlippagePct * 100).toFixed(0)} percent AND mid-price PnL is above the stop-loss threshold → STAY (selling now would crystallize MORE loss than the position is currently down — wait for liquidity to return)
- For CLOSE decisions, weight the realistic PnL more than mid-price PnL

Fee/TVL guidance (values are percent — compare directly, e.g. 76.89 means 76.89%):
- Fee/TVL below 2 percent while in-range → consider CLOSE (pool dying)
- Fee/TVL between 2 and 10 percent → acceptable but not great, STAY only if PnL positive
- Fee/TVL above 10 percent → good fee generation, bias toward STAY

Other:
- Fees above 0.01 SOL accumulated and in-range → CLAIM_FEES then STAY
- Position open less than 1 hour → bias toward STAY unless stop-loss triggers
- Position open more than 168 hours (7 days) → bias toward CLOSE (rotate capital)

Output via tool call \`submit_heal_decision\`.`;
}

// ── HEALER ─────────────────────────────────────────────────────

export async function askHealer(position: any, liveData: {
  currentPrice:       number;
  feesEarnedSol:      number;
  isInRange:          boolean;
  pnlPct:             number;
  realizablePnlPct?:  number;
  closeSlippagePct?:  number;
  hoursOpen:          number;
  currentTvl:         number;
  currentVolume:      number;
  feeTvlRatio:        number;
}): Promise<HealDecision> {

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
In Range          : ${liveData.isInRange ? 'YES' : 'NO — not earning fees'}
PnL mid-price     : ${liveData.pnlPct.toFixed(2)} percent  (optimistic — assumes zero slippage on close)
PnL realizable    : ${(liveData.realizablePnlPct ?? liveData.pnlPct).toFixed(2)} percent  (after swapping token side back to SOL)
Close slippage    : ${(liveData.closeSlippagePct ?? 0).toFixed(2)} percent  (price impact of liquidating now)
Fees earned       : ${liveData.feesEarnedSol.toFixed(6)} SOL
Current price     : ${liveData.currentPrice.toFixed(8)}

=== POOL HEALTH ===
Current TVL  : $${liveData.currentTvl.toLocaleString()}
Volume 24h   : $${liveData.currentVolume.toLocaleString()}
Fee/TVL ratio: ${(liveData.feeTvlRatio).toFixed(2)} percent
`,
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

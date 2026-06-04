# Nova LP Agent

Autonomous Meteora DLMM liquidity-provider agent. TypeScript, SQLite, OpenRouter LLM layer (Claude / DeepSeek / any tool-use model), multi-source pool screening, on-chain reconciliation, per-pool backtest engine.

Forked from and substantially rebuilt over [yunus-0x/meridian](https://github.com/yunus-0x/meridian).

## What it does

Two cycles run on cron:

- **Hunter** (every 15 min) — pulls fresh DLMM pools from Meteora discovery, enriches with Birdeye token data + Helius whale activity, computes a 0–100 Nova Score, and asks the LLM to DEPLOY or SKIP each candidate.
- **Healer** (every 5 min, one task per open position in parallel) — reads live position state from the DLMM SDK + live pool health, then asks the LLM to STAY / CLAIM_FEES / CLOSE / REDEPLOY.

After every close, a third LLM call distills one lesson sentence (`If [condition], then [action], because [reason]`) that's stored in SQLite and injected into subsequent hunter/healer prompts.

## Compared to Meridian

| | Meridian | Nova LP |
|---|---|---|
| Language | JavaScript | TypeScript (strict) |
| LLM | Single-provider | OpenRouter — any tool-use model (Claude, DeepSeek V4 Flash, etc.) |
| Database | JSON files | SQLite — positions, lessons, cooldown, snapshots, agent_state |
| Screening | Meteora + OKX | Meteora + Birdeye (holders / mcap) + Helius (whale swaps) |
| Risk scoring | Boolean flags | Nova Score: weighted multi-factor + hard penalties |
| Healer logic | Static rules | LLM with hard-rule guardrails + lesson injection |
| Exit logic | SL / TP | SL / TP + drawdown stop + consecutive-loss circuit breaker + per-pool cooldown |
| Boot | Trust DB | On-chain reconciliation; orphans marked + alerted |
| RPC failure | Crash | Rotate through fallback endpoints |
| Cycle safety | Best-effort | Cycle locks block overlapping runs |
| IL accounting | Uniswap-v2 formula | DLMM per-bin valuation |
| Time-in-range | Snapshot | Accumulated over position lifetime |
| Backtest | None | Per-pool snapshot replay engine |
| Logging | Console | Winston: console + rotated file |

## Architecture

```
src/
├── index.ts                   Hunter + Healer crons, circuit breakers, bootstrap
├── config.ts                  Env-driven configuration (validated at load)
├── cli.ts                     screen / stats / positions commands
├── db.ts                      SQLite schema + helpers
├── screening/hunter.ts        Pool discovery, enrichment, Nova Score
├── intelligence/llm.ts        OpenRouter call, tool schemas, prompts, lesson distiller
├── execution/dlmm.ts          Meteora SDK wrapper: deploy, claim, close, reconcile
├── backtest/engine.ts         Per-pool historical replay against snapshots
├── notifications/telegram.ts  Alerts + interactive commands
└── utils/                     logger, solPrice
```

## Nova Score

Composite 0–100 — higher means better LP candidate.

```
Fee/TVL ratio        0–30 pts    yield efficiency (weighted highest)
Volume 24h           0–20 pts    liquidity tier (5 / 10 / 15 / 20 brackets)
Organic score        0–20 pts    Meteora internal quality metric
TVL sweet spot       0–15 pts    $20k–$100k = ideal, $10k–$200k = ok
Holder count         0–10 pts    distribution
KOL / whale          0–5  pts    on-chain signal

Penalties
Wash trading         -50         (effectively hard skip)
Rugpull flag        -100         (hard skip)
Bundle  > 30%        -15         supply concentrated
Bundle  > 50%        -35         high manipulation risk
```

Additional hard-skip rules baked into the hunter prompt (`intelligence/llm.ts`):
- Fee/TVL < 5%
- Nova Score < 50
- Bundle > 40%

## Safety features

- **Boot reconciliation** — every DB row with `status='open'` is verified against on-chain `getPositionsByUserAndLbPair`. Missing positions are marked `orphan` and reported to Telegram for manual review. Catches crashes mid-close and prevents ghost-position double-acts.
- **RPC fallback rotation** — primary + `SOLANA_RPC_FALLBACKS` (comma-separated). Read-only calls iterate the full list before giving up.
- **Cycle locks** — overlapping hunter or healer ticks are skipped rather than queued.
- **Drawdown emergency stop** — `MAX_DRAWDOWN_PCT` triggers pause + alert.
- **Consecutive-loss circuit breaker** — auto-pause after 3 losses in a row.
- **Per-pool cooldown** — 4-hour lockout on any pool that closed at a loss.
- **Stop-loss / take-profit** — hard rules in the healer prompt (`STOP_LOSS_PCT`, `TAKE_PROFIT_PCT`).
- **RPC health gate** — refuses to start if every endpoint is unreachable.
- **Position state machine** — `open | closing | closed | orphan` enforced at the DB layer.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
# edit .env
```

### 2. Required env vars

```bash
WALLET_PRIVATE_KEY=base58_key
SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=...
SOLANA_RPC_FALLBACKS=https://api.mainnet-beta.solana.com,https://...   # comma-separated

OPENROUTER_API_KEY=sk-or-v1-...
HELIUS_API_KEY=...                    # whale tracking + RPC
BIRDEYE_API_KEY=...                   # optional but recommended

TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### 3. Pick your model

Default config:

```bash
HUNTER_MODEL=anthropic/claude-sonnet-4.6     # entry decisions — quality matters
HEALER_MODEL=anthropic/claude-haiku-4.5      # frequent, rule-bounded
LESSON_MODEL=anthropic/claude-haiku-4.5      # post-close summary
```

For ~95% cheaper LLM cost (with some judgement-quality tradeoff on the hunter), switch all three to DeepSeek V4 Flash:

```bash
HUNTER_MODEL=deepseek/deepseek-v4-flash
HEALER_MODEL=deepseek/deepseek-v4-flash
LESSON_MODEL=deepseek/deepseek-v4-flash
```

When using non-Anthropic models, OpenRouter may route to providers that don't support `tools` — add `provider: { require_parameters: true }` in `intelligence/llm.ts` to filter those out. The `cache_control` sanitizer (`llm.ts`) already strips Anthropic-only cache directives for other providers.

### 4. Run

```bash
npm run dry        # dry mode — no real transactions, on-chain price + simulated fees
npm run dev        # live mode (only after dry validation)
```

### 5. CLI tools

```bash
npm run screen     # one-off pool scan, prints candidates + Nova Score
npm run stats      # closed-position performance summary
npm run positions  # open positions with live state
```

## Telegram commands

| Command | Action |
|---|---|
| `/status` | Agent status + performance summary |
| `/positions` | Open positions with live PnL, fees, in-range status |
| `/stop` | Pause both cycles |
| `/start` | Resume |
| `/report` | Force daily report now |
| `/closeall` | Close every open position and pause |

Auto alerts on: agent start, deploy, close, out-of-range, emergency stop, orphan reconciliation.

## Risk parameters (defaults)

```
TOTAL_CAPITAL_SOL=2.0
MAX_POSITION_SOL=0.4         # 20% of total
MAX_POSITIONS=5
MIN_POSITION_SOL=0.05
STOP_LOSS_PCT=0.15
TAKE_PROFIT_PCT=0.25
MAX_DRAWDOWN_PCT=0.30
```

For your first live deployment, use the tighter Phase 3 caps documented in `GOING_LIVE.md` (0.5 SOL total, 2 positions, 10% SL, 20% drawdown).

## Self-learning loop

After every close:
1. Lesson LLM receives the closed position (entry conditions, exit reason, PnL, fee APR, time-in-range).
2. It returns one sentence: `If [measurable condition], then [action], because [reason]`.
3. Lesson is stored in SQLite with a confidence score, tagged by role (HUNTER / HEALER / GENERAL).
4. Top-N relevant lessons are injected into subsequent prompts.

**Caveat:** there is no review step. A bad lesson poisons future cycles. Inspect the `lessons` table periodically and prune.

## Backtest

`src/backtest/engine.ts` replays per-pool snapshots stored in the `snapshots` table. Use it to evaluate the strategy against historical pool data before letting it touch real capital. No published results yet — run it.

## Deploy to VPS

```bash
npm run build
pm2 start dist/index.js --name nova-lp
pm2 save
pm2 startup
```

Or under `screen`:

```bash
screen -S nova-lp
npm run dev
# Ctrl-A, then D to detach
```

## Status

The codebase has had meaningful safety work since the original fork: orphan reconciliation, on-chain pool health, DLMM-specific IL math, RPC rotation, time-in-range accumulator, circuit breakers. The framework is solid.

It does **not** yet have evidence of strategy edge — the backtest engine exists but published results don't. See `GOING_LIVE.md` for the pre-live checklist before any real-capital deployment.

## Disclaimer

For educational purposes. DLMM LP carries impermanent-loss risk that can exceed fee earnings. This is not financial advice.

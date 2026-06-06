# Going Live — Nova LP Agent Readiness

Pre-live assessment after rule-based refactoring (Phases 1–5).

## What changed

- **Hunter is now fully rule-based** — Nova Score ≥ 60 gate + hardcoded thresholds. No LLM call. Saves ~$1.44/day.
- **Healer is tiered** — hard rules (SL/TP/OOR/deploy-count/pool-dying/max-age) fire first; LLM only for gray zone. Saves ~$0.85/day.
- **Lessons system removed** — self-referential LLM→LLM loop with poisoning risk. May revisit with stats-based insights later.
- **REDEPLOY removed** — crystallizes IL twice, no evidence of edge. All exits now use CLOSE.
- **Dry-run fees corrected** — `fee_tvl_ratio` was treated as daily but it's annualized APR (off by ~365×).
- **PnL recorded at realizable price** — mid-price recording was systematically overestimating returns.
- **OOR alert throttling** — once per 4 hours per position instead of every tick.
- **Pre-deploy liquidity check** — skips if pool TVL < 5× deploy size.
- **Pool diversification** — filters out tokens already in an open position.
- **`/closeall` actually closes positions** — was broken before.
- **Daily report timezone fixed** — SQLite `date()` now uses UTC.
- **Dead code removed** — whale/KOL/bundle detection, `smart_wallets` and `threshold_history` tables, `fetchPoolStats` call in healer cycle, `lessonModel` config.

## What's safe now

- Dry simulator uses real Meteora pool price (DLMM SDK), not random
- `isInRange`, `positionValue`, fee accrual deterministic and based on actual price
- Healer hard rules fire ~70% of the time — no LLM needed
- LLM only used for ambiguous gray-zone healer decisions
- Single-sided deploy + close path correct (X/Y detection, IL accounting)
- Deploy cooldown: max 3 deploys per pool per 7 days, 48h after hitting limit
- New tokens filtered if already in an open position

## What's still risky before live

1. **`fetchPoolStats` broken in live mode.**
   Healer prompt gets ROUTER-SOL TVL/volume for ALL pools because Meteora discovery API ignores `pool_address` filter. Core logic (price, isInRange, fees) is safe (on-chain SDK), but LLM could make wrong decisions from wrong pool data. **Must fix before live.**

2. **No position state machine.**
   If close tx fails mid-way (network hiccup, RPC error), position could be `status='open'` in DB but already closed on-chain — or vice versa. No startup reconciliation to verify `open` positions still exist on Solana. Live mode could "lose" positions or double-close.

3. **`rotateRpc` not called from `getDLMMReadOnly` failure.**
   If primary RPC down, healer skips tick — no fallback attempted.

4. **No backtest.**
   Strategy not validated on historical data. All confidence based on a few days of dry mode.

5. **Time-in-range still snapshot.**
   `inRangePct = isInRange ? 100 : 50` — rough approximation.

6. **IL model approximate.**
   Uses Uniswap-v2 formula, not exact DLMM concentrated-liquidity math. Dry PnL can drift 1–3% from reality.

## Pre-live playbook

### Phase 1 — Validate dry (1–2 weeks)

- Reset DB, run dry for a week
- Target metrics:
  - WR 45–65% (if 90%+ or <30%, there's a bug)
  - `exit_reason` mix varied (no single reason >60%)
  - Avg fee APR > 50%
  - Healer LLM calls < 30% of total ticks (rest handled by hard rules)

### Phase 2 — Fix critical (before live)

- Fix live `fetchPoolStats` (or drop and use snapshot like dry mode)
- Add `getDLMMReadOnly` → trigger `rotateRpc()` on failure
- Position state machine minimum:
  - Add status enum: `open | closing | closed | orphan`
  - On boot, for every `open` position, verify pubkey exists on-chain via `dlmmPool.getPositionsByUserAndLbPair`
  - If absent → mark `orphan` + alert Telegram

### Phase 3 — Live with safety net

- Wallet dedicated, NOT main wallet. Fund minimally.
- Start config:
  ```
  TOTAL_CAPITAL_SOL=0.5      # start 0.5 SOL ≈ $50
  MAX_POSITION_SOL=0.1       # max 0.1 per position
  MAX_POSITIONS=2            # only 2 parallel
  STOP_LOSS_PCT=0.10         # tighter than default 15%
  MAX_DRAWDOWN_PCT=0.20      # auto-stop at -20%
  ```
- Monitor Telegram intensively for first 48 hours.
- After 10–20 closed positions without anomalies, gradually increase capital.

### Phase 4 — Scale

- After ≥100 closed positions: implement Kelly sizing (enough data)
- Add backtest framework
- Add unit tests for `computeNovaScore` + IL math

## Honest take

The rule-based refactoring removed ~$2.30/day in LLM costs and eliminated the worst failure modes (lessons poisoning, overconfident whale entries, REDEPLOY churn). Dry-run PnL should meaningfully improve from corrected fee math alone. **Still recommend starting with 0.5 SOL and monitoring closely** — the remaining risks (fetchPoolStats, no state machine) are real but manageable at small scale.

import { config } from '../config';
import { HealDecision } from '../intelligence/llm';

const MAX_AGE_HOURS = 168; // 7 days

interface HealerInput {
  pnlPct: number;
  realizablePnlPct: number;
  isInRange: boolean;
  hoursOpen: number;
  feesEarnedSol: number;
  feeTvlRatio: number;
  closeSlippagePct: number;
}

export function hardRuleDecision(input: HealerInput): HealDecision | null {
  // Use realizable PnL when close slippage is high — this is what you'd actually get
  const effectivePnl = input.closeSlippagePct > config.maxCloseSlippagePct
    ? input.realizablePnlPct
    : input.pnlPct;

  // Stop loss
  if (effectivePnl < -config.stopLossPct * 100) {
    return { action: 'CLOSE', reasoning: `stop loss: effective PnL ${effectivePnl.toFixed(1)}%`, urgency: 'HIGH', newStrategy: null };
  }

  // Take profit
  if (input.pnlPct > config.takeProfitPct * 100) {
    return { action: 'CLOSE', reasoning: `take profit: PnL ${input.pnlPct.toFixed(1)}%`, urgency: 'MEDIUM', newStrategy: null };
  }

  // Out of range too long
  if (!input.isInRange && input.hoursOpen > 4) {
    return { action: 'CLOSE', reasoning: `OOR ${input.hoursOpen.toFixed(0)}h — pool shifted`, urgency: 'MEDIUM', newStrategy: null };
  }

  // Pool dying while in range — feeTvlRatio is annualized APR, normalize to daily
  const dailyFeeTvl = (input.feeTvlRatio ?? 0) / 365;
  if (input.isInRange && dailyFeeTvl < 0.02) {
    return { action: 'CLOSE', reasoning: `pool dying: daily fee/TVL ${(dailyFeeTvl * 100).toFixed(1)}%`, urgency: 'MEDIUM', newStrategy: null };
  }

  // Max age — close stale positions
  if (input.hoursOpen > MAX_AGE_HOURS) {
    const label = input.pnlPct > 0 ? 'take profit' : 'cut loss';
    return { action: 'CLOSE', reasoning: `max age ${input.hoursOpen.toFixed(0)}h — ${label}`, urgency: 'LOW', newStrategy: null };
  }

  // Claim fees when conditions are favorable
  if (input.feesEarnedSol > 0.01 && input.isInRange && input.pnlPct > 0) {
    return { action: 'CLAIM_FEES', reasoning: `harvest ${input.feesEarnedSol.toFixed(4)} SOL fees`, urgency: 'LOW', newStrategy: null };
  }

  // Tier 1 done — return null to signal "ask LLM for gray zone"
  return null;
}

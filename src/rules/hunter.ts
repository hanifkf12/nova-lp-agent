import { config } from '../config';
import { PoolCandidate } from '../screening/hunter';
import { DeployDecision } from '../intelligence/llm';
import { isPoolOnCooldown } from '../db';
import { logger } from '../utils/logger';

export function chooseStrategy(pool: PoolCandidate): 'spot' | 'curve' | 'bid_ask' {
  // Meme coins are volatile — use Bid-Ask for higher price swings
  // Bid-Ask places more liquidity at edges, good for DCA-style entry/exit
  if (pool.priceChange24h > 15) return 'bid_ask';

  // Curve concentrates liquidity at center — high fee capture for stable pools
  // Threshold: 5% daily fee/TVL = 1825% APR (reachable for high-fee pools)
  const dailyFeeTvl = (pool.feeTvlRatio ?? 0) / 365;
  if (dailyFeeTvl > 0.05) return 'curve';

  // Spot = uniform distribution — default for most meme coin pools
  return 'spot';
}

function skip(c: PoolCandidate, reason: string): DeployDecision {
  return {
    action: 'SKIP',
    strategy: 'spot',
    solAmount: 0,
    binRange: config.binRange,
    confidence: 0,
    reasoning: `Skip: ${reason}`,
    learnedFrom: null,
    warnings: [],
  };
}

export function hunterDecisions(
  candidates: PoolCandidate[],
  openCount: number,
  solBalance: number,
): DeployDecision[] {
  return candidates.map(c => {
    if (isPoolOnCooldown(c.poolAddress)) {
      return skip(c, 'pool on cooldown');
    }
    if (c.novaScore < 60) {
      return skip(c, `nova score ${c.novaScore.toFixed(0)} < 60`);
    }
    if (c.feeTvlRatio < 0.05) {
      return skip(c, `fee/TVL ${(c.feeTvlRatio * 100).toFixed(1)}% < 5%`);
    }
    if (c.riskLevel === 'HIGH') {
      return skip(c, 'risk level HIGH');
    }
    if (c.isRugpull || c.isWash) {
      return skip(c, 'rugpull/wash detected');
    }
    if (c.mcapUsd > config.screening.maxMcap && c.mcapUsd > 0) {
      return skip(c, `mcap $${(c.mcapUsd / 1e6).toFixed(1)}M too high`);
    }
    if (c.holderCount < config.screening.minHolders && c.holderCount > 0) {
      return skip(c, `holders ${c.holderCount} < ${config.screening.minHolders}`);
    }
    if (solBalance < config.minPositionSol + 0.1) {
      return skip(c, 'insufficient SOL balance');
    }

    const strategy = config.lpStrategy === 'auto' ? chooseStrategy(c) : config.lpStrategy;

    logger.info('Hunter rule decision', {
      symbol:     c.tokenSymbol,
      action:     'DEPLOY',
      strategy,
      novaScore:  c.novaScore.toFixed(0),
      feeTvl:     (c.feeTvlRatio * 100).toFixed(1) + '%',
    });

    return {
      action: 'DEPLOY',
      strategy,
      solAmount: config.maxPositionSol,
      binRange: config.binRange,
      confidence: 1,
      reasoning: `Nova ${c.novaScore.toFixed(0)} • Fee/TVL ${(c.feeTvlRatio * 100).toFixed(1)}% • vol $${(c.volume24hUsd / 1000).toFixed(0)}k`,
      learnedFrom: null,
      warnings: [],
    };
  });
}

import cron from 'node-cron';
import { config } from './config';
import { logger } from './utils/logger';
import { refreshSolPriceUsd } from './utils/solPrice';
import {
  initDB, insertPosition, closePosition as dbClosePosition,
  getOpenPositions, addLesson, setState,
  setPoolCooldown,
  addFeesClaimed,
} from './db';
import { huntPools } from './screening/hunter';
import { askHunterBatch, askHealer, deriveLesson } from './intelligence/llm';
import {
  getSolBalance, deployPosition, getConnection, rotateRpc,
  claimFees, closePosition as execClose,
  getLivePositionData,
} from './execution/dlmm';
import {
  alertStarted, alertDeploy, alertClose,
  alertOutOfRange, alertEmergencyStop,
  sendDailyReport, setupCommands,
} from './notifications/telegram';

const agentState = {
  isRunning: true,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 3,
};

const cycleLocks = {
  hunter: false,
  healer: false,
};

function positionByNovaScore(novaScore: number, baseMax: number): number {
  if (novaScore >= 90) return baseMax;
  if (novaScore >= 75) return baseMax * 0.80;
  if (novaScore >= 65) return baseMax * 0.60;
  return baseMax * 0.40;
}

// ── RPC health check (with rotation) ───────────────────────────

async function checkRpcHealth(): Promise<boolean> {
  for (let i = 0; i < (1 + config.rpcFallbacks.length); i++) {
    try {
      const conn = getConnection();
      const version = await conn.getVersion();
      const block   = await conn.getBlockHeight();
      logger.info('RPC healthy', { version: version['solana-core'], block });
      return true;
    } catch (err) {
      logger.error('RPC health check failed — rotating', { err });
      rotateRpc();
    }
  }
  return false;
}

// ── HUNTER CYCLE ───────────────────────────────────────────────

async function runHunterCycle(): Promise<void> {
  if (!agentState.isRunning) return;
  if (cycleLocks.hunter) {
    logger.warn('Hunter cycle already running — skipping tick');
    return;
  }
  cycleLocks.hunter = true;
  logger.info('═══ Hunter cycle start ═══');

  try {
    const openPositions = getOpenPositions();

    if (openPositions.length >= config.maxPositions) {
      logger.info('Max positions reached, skipping hunter cycle');
      return;
    }

    let solBalance = await getSolBalance();
    setState('sol_balance', solBalance.toString());

    const deployed   = openPositions.reduce((s, p) => s + p.sol_deployed, 0);
    const totalValue = solBalance + deployed;
    const drawdown   = (config.totalCapitalSol - totalValue) / config.totalCapitalSol;

    if (drawdown >= config.maxDrawdownPct) {
      agentState.isRunning = false;
      await alertEmergencyStop(drawdown * 100);
      logger.error('Emergency stop!', { drawdown, totalValue });
      return;
    }

    const candidates = await huntPools();
    if (candidates.length === 0) {
      logger.info('No candidates found this cycle');
      return;
    }

    const batch     = candidates.slice(0, 3);
    const decisions = await askHunterBatch(batch, openPositions.length, solBalance);

    let openCount = openPositions.length;
    for (let i = 0; i < decisions.length && i < batch.length; i++) {
      const candidate = batch[i];
      const decision  = decisions[i];

      if (openCount >= config.maxPositions) break;
      if (solBalance < config.minPositionSol + 0.1) {
        logger.warn('SOL balance too low to deploy', { solBalance });
        break;
      }

      // Single gate: trust the LLM. novaScore informs the prompt but
      // doesn't block on its own.
      if (decision.action !== 'DEPLOY' || decision.confidence < 0.65) {
        logger.info(`Skip ${candidate.tokenSymbol}`, {
          reason: decision.reasoning.slice(0, 80),
          confidence: decision.confidence,
        });
        continue;
      }

      const strategy = config.lpStrategy === 'auto' ? decision.strategy : config.lpStrategy;
      const sized    = positionByNovaScore(
        candidate.novaScore,
        Math.min(Math.min(decision.solAmount, config.maxPositionSol), solBalance - 0.1)
      );

      if (sized < config.minPositionSol) {
        logger.info('Sized below minimum, skipping', { sized, min: config.minPositionSol });
        continue;
      }

      const result = await deployPosition(
        candidate.poolAddress,
        strategy,
        sized,
        decision.binRange || config.binRange,
      );

      if (!result.success) {
        logger.error('Deploy failed', { error: result.error });
        continue;
      }

      const posId = insertPosition({
        poolAddress:    candidate.poolAddress,
        tokenMint:      candidate.tokenMint,
        tokenSymbol:    candidate.tokenSymbol,
        binStep:        candidate.binStep,
        strategy,
        solDeployed:    sized,
        entryPrice:     result.entryPrice ?? 0,
        priceRangeMin:  result.priceRangeMin ?? 0,
        priceRangeMax:  result.priceRangeMax ?? 0,
        binCount:       result.binCount ?? config.binRange,
        tvlUsd:         candidate.tvlUsd,
        volume24hUsd:   candidate.volume24hUsd,
        feeTvlRatio:    candidate.feeTvlRatio,
        organicScore:   candidate.organicScore,
        holderCount:    candidate.holderCount,
        mcapUsd:        candidate.mcapUsd,
        whalePresent:   candidate.whalePresent,
        kolPresent:     candidate.kolPresent,
        bundlePct:      candidate.bundlePct,
        llmReasoning:   decision.reasoning,
        llmConfidence:  decision.confidence,
        deployScore:    candidate.novaScore,
        positionPubkey: result.positionPubkey,
      });

      logger.info('Position opened', { posId, symbol: candidate.tokenSymbol, sol: sized });

      await alertDeploy({
        symbol:      candidate.tokenSymbol,
        poolAddress: candidate.poolAddress,
        solAmount:   sized,
        strategy,
        novaScore:   candidate.novaScore,
        confidence:  decision.confidence,
        reasoning:   decision.reasoning,
        feeTvlRatio: candidate.feeTvlRatio,
      });

      // Decrement local balance + open count instead of re-reading state.
      solBalance = Math.max(0, solBalance - sized - 0.005); // ~5k lamports rent buffer
      openCount += 1;
      setState('sol_balance', solBalance.toString());
    }

  } catch (err) {
    logger.error('Hunter cycle error', { err });
  } finally {
    cycleLocks.hunter = false;
    logger.info('═══ Hunter cycle end ═══');
  }
}

// ── HEALER CYCLE (parallel) ────────────────────────────────────

async function healOnePosition(pos: any): Promise<void> {
  const liveData = await getLivePositionData(
    pos.pool_address,
    pos.position_pubkey ?? '',
    pos.entry_price ?? 0,
    pos.sol_deployed ?? 0,
  );

  if (!liveData) {
    logger.warn('Could not get live data for position', { id: pos.id });
    return;
  }

  const hoursOpen = (Date.now() - pos.opened_at) / 3600000;
  const totalValueSol = liveData.positionValueSol + liveData.feesEarnedSol;
  const pnlPct = pos.sol_deployed > 0
    ? ((totalValueSol - pos.sol_deployed) / pos.sol_deployed) * 100
    : 0;

  if (!liveData.isInRange) {
    await alertOutOfRange(pos.token_symbol, pos.pool_address);
  }

  const decision = await askHealer(pos, {
    currentPrice:  liveData.currentPrice,
    feesEarnedSol: liveData.feesEarnedSol,
    isInRange:     liveData.isInRange,
    pnlPct,
    hoursOpen,
    currentTvl:    liveData.currentTvl,
    currentVolume: liveData.currentVolume,
    feeTvlRatio:   liveData.feeTvlRatio,
  });

  logger.info('Healer decision', {
    symbol: pos.token_symbol,
    action: decision.action,
    urgency: decision.urgency,
    pnlPct: pnlPct.toFixed(2),
    inRange: liveData.isInRange,
  });

  if (decision.action === 'CLAIM_FEES') {
    const claimed = await claimFees(pos.pool_address, pos.position_pubkey ?? '');
    if (claimed.success) {
      addFeesClaimed(pos.id, claimed.feesClaimedSol);
      logger.info('Fees claimed', { sol: claimed.feesClaimedSol, posId: pos.id });
    } else {
      logger.error('Claim fees failed', { error: claimed.error, posId: pos.id });
    }
    return;
  }

  if (decision.action !== 'CLOSE' && decision.action !== 'REDEPLOY') return;

  const closed = await execClose(pos.pool_address, pos.position_pubkey ?? '');
  if (!closed.success) {
    logger.error('Failed to close position', { error: closed.error, posId: pos.id });
    return;
  }

  // Accumulate all fees: previously claimed (claim_fees decisions) + final
  const totalFees = (pos.fees_claimed_sol ?? 0) + closed.feesClaimedSol;
  const exitReason = decision.action === 'REDEPLOY' ? 'redeploy' : 'healer_close';

  const feeApr = hoursOpen > 0
    ? (totalFees / pos.sol_deployed) * (8760 / hoursOpen) * 100
    : 0;
  const inRangePct = liveData.isInRange ? 100 : 50;

  const { pnlSol, pnlPct: realizedPnlPct } = dbClosePosition(pos.id, {
    feesSol:          totalFees,
    positionValueSol: liveData.positionValueSol,
    exitPrice:        closed.exitPrice,
    exitReason,
    feeApr,
    timeInRangePct:   inRangePct,
  });

  // Lesson generation (best-effort)
  try {
    const posData = {
      ...pos,
      fees_claimed_sol:  totalFees,
      fee_apr_pct:       feeApr,
      time_in_range_pct: inRangePct,
      exit_reason:       exitReason,
      pnl_pct:           realizedPnlPct,
      pnl_sol:           pnlSol,
    };
    const lesson = await deriveLesson(posData);
    if (lesson) {
      addLesson(
        decision.action === 'REDEPLOY' ? 'HEALER' : 'GENERAL',
        lesson,
        String(pos.id),
        0.75,
      );
    }
  } catch (err) {
    logger.warn('Lesson derivation failed', { err });
  }

  await alertClose({
    symbol:     pos.token_symbol,
    feesSol:    totalFees,
    pnlPct:     realizedPnlPct,
    exitReason,
    hoursOpen,
    feeApr,
  });

  if (pnlSol < 0) {
    agentState.consecutiveLosses += 1;
    logger.warn(`Loss streak: ${agentState.consecutiveLosses}/${agentState.maxConsecutiveLosses}`);
    setPoolCooldown(pos.pool_address, 4);
    if (agentState.consecutiveLosses >= agentState.maxConsecutiveLosses) {
      agentState.isRunning = false;
      logger.error('Circuit breaker triggered — auto-paused after consecutive losses');
      await alertEmergencyStop(0);
    }
  } else {
    agentState.consecutiveLosses = 0;
  }
}

async function runHealerCycle(): Promise<void> {
  if (!agentState.isRunning) return;
  if (cycleLocks.healer) {
    logger.warn('Healer cycle already running — skipping tick');
    return;
  }
  cycleLocks.healer = true;

  try {
    const openPositions = getOpenPositions();
    if (openPositions.length === 0) return;

    logger.info(`Healer: monitoring ${openPositions.length} positions`);

    // Independent per-position work — run in parallel.
    const results = await Promise.allSettled(
      openPositions.map(p => healOnePosition(p))
    );
    for (const r of results) {
      if (r.status === 'rejected') logger.error('Healer task failed', { err: r.reason });
    }
  } finally {
    cycleLocks.healer = false;
  }
}

// ── SOL price tick (every 15 min) ──────────────────────────────

async function runSolPriceTick(): Promise<void> {
  try {
    await refreshSolPriceUsd();
  } catch (err) {
    logger.warn('SOL price tick failed', { err });
  }
}

// ── Bootstrap ──────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('Starting Nova LP Agent', {
    dryRun:         config.dryRun,
    totalCapital:   config.totalCapitalSol,
    maxPositions:   config.maxPositions,
    hunterInterval: config.hunterIntervalMin,
    healerInterval: config.healerIntervalMin,
    hunterModel:    config.hunterModel,
    healerModel:    config.healerModel,
  });

  const fs   = await import('fs');
  const path = await import('path');
  const dataDir = path.dirname(path.resolve(config.dbPath));
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  initDB();

  const rpcOk = await checkRpcHealth();
  if (!rpcOk) {
    logger.error('RPC unhealthy on all endpoints — refusing to start');
    process.exit(1);
  }

  setupCommands(agentState);

  const solBalance = await getSolBalance();
  setState('sol_balance', solBalance.toString());
  await refreshSolPriceUsd();

  await alertStarted(solBalance);

  cron.schedule(`*/${config.hunterIntervalMin} * * * *`, runHunterCycle);
  cron.schedule(`*/${config.healerIntervalMin} * * * *`, runHealerCycle);
  cron.schedule('*/15 * * * *', runSolPriceTick);
  cron.schedule(`0 ${config.dailyReportHourUtc} * * *`, sendDailyReport);

  await runHunterCycle();
  await runHealerCycle();

  logger.info('Nova LP Agent running', {
    hunter: `every ${config.hunterIntervalMin} min`,
    healer: `every ${config.healerIntervalMin} min`,
    report: `${config.dailyReportHourUtc}:00 UTC`,
  });
}

main().catch(err => {
  logger.error('Fatal startup error', { err });
  process.exit(1);
});

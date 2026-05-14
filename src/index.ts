import cron from 'node-cron';
import { config } from './config';
import { logger } from './utils/logger';
import {
  initDB, insertPosition, closePosition as dbClosePosition,
  getOpenPositions, addLesson, setState, getState,
  setPoolCooldown, buildPerformanceMemory,
  addFeesClaimed, recordSolPrice,
} from './db';
import { huntPools } from './screening/hunter';
import { askHunterBatch, askHealer, deriveLesson } from './intelligence/llm';
import {
  getSolBalance, deployPosition, getConnection,
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

function positionByNovaScore(novaScore: number, baseMax: number): number {
  if (novaScore >= 90) return baseMax;
  if (novaScore >= 75) return baseMax * 0.80;
  if (novaScore >= 65) return baseMax * 0.60;
  return baseMax * 0.40;
}

// ── RPC health check ───────────────────────────────────────────

async function checkRPHealth(): Promise<boolean> {
  try {
    const conn = getConnection();
    const version = await conn.getVersion();
    const block = await conn.getBlockHeight();
    logger.info('RPC healthy', { version: version['solana-core'], block });
    return true;
  } catch (err) {
    logger.error('RPC health check failed', { err });
    return false;
  }
}

// ── HUNTER CYCLE — cari dan deploy pool baru ──────────────────

async function runHunterCycle(): Promise<void> {
  if (!agentState.isRunning) return;
  logger.info('═══ Hunter cycle start ═══');

  try {
    const openPositions = getOpenPositions();

    if (openPositions.length >= config.maxPositions) {
      logger.info('Max positions reached, skipping hunter cycle');
      return;
    }

    const solBalance = await getSolBalance();
    setState('sol_balance', solBalance.toString());

    const deployed    = openPositions.reduce((s, p) => s + p.sol_deployed, 0);
    const totalValue  = solBalance + deployed;
    const drawdown    = (config.totalCapitalSol - totalValue) / config.totalCapitalSol;

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

    for (let i = 0; i < decisions.length && i < batch.length; i++) {
      const candidate = batch[i];
      const decision  = decisions[i];

      const finalPositions = getOpenPositions();
      if (finalPositions.length >= config.maxPositions) break;
      if (solBalance < config.minPositionSol + 0.1) {
        logger.warn('SOL balance too low to deploy');
        break;
      }

      if (decision.action !== 'DEPLOY' || decision.confidence < 0.65) {
        logger.info(`Skip ${candidate.tokenSymbol}`, {
          reason: decision.reasoning.slice(0, 60),
        });
        continue;
      }

      const strategy = config.lpStrategy === 'auto' ? decision.strategy : config.lpStrategy;
      const sized    = positionByNovaScore(
        candidate.novaScore,
        Math.min(Math.min(decision.solAmount, config.maxPositionSol), solBalance - 0.1)
      );

      const result = await deployPosition(
        candidate.poolAddress,
        strategy,
        sized,
        decision.binRange,
      );

      if (!result.success) {
        logger.error('Deploy failed', { error: result.error });
        continue;
      }

      const posId = insertPosition({
        poolAddress:   candidate.poolAddress,
        tokenMint:     candidate.tokenMint,
        tokenSymbol:   candidate.tokenSymbol,
        binStep:       candidate.binStep,
        strategy,
        solDeployed:   sized,
        entryPrice:    result.entryPrice ?? 0,
        priceRangeMin: result.priceRangeMin ?? 0,
        priceRangeMax: result.priceRangeMax ?? 0,
        binCount:      result.binCount ?? config.binRange,
        tvlUsd:        candidate.tvlUsd,
        volume24hUsd:  candidate.volume24hUsd,
        feeTvlRatio:   candidate.feeTvlRatio,
        organicScore:  candidate.organicScore,
        holderCount:   candidate.holderCount,
        mcapUsd:       candidate.mcapUsd,
        whalePresent:  candidate.whalePresent,
        kolPresent:    candidate.kolPresent,
        bundlePct:     candidate.bundlePct,
        llmReasoning:  decision.reasoning,
        llmConfidence: decision.confidence,
        deployScore:   candidate.novaScore,
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

      const newBal = await getSolBalance();
      setState('sol_balance', newBal.toString());
    }

  } catch (err) {
    logger.error('Hunter cycle error', { error: (err as Error).message });
  }

  logger.info('═══ Hunter cycle end ═══');
}

// ── HEALER CYCLE — monitor dan manage posisi aktif ────────────

async function runHealerCycle(): Promise<void> {
  if (!agentState.isRunning) return;

  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  logger.info(`Healer: monitoring ${openPositions.length} positions`);

  for (const pos of openPositions) {
    try {
      const liveData = await getLivePositionData(
        pos.pool_address,
        pos.position_pubkey ?? '',
      );

      if (!liveData) {
        logger.warn('Could not get live data for position', { id: pos.id });
        continue;
      }

      const hoursOpen = (Date.now() - pos.opened_at) / 3600000;
      const pnlPct    = (liveData.feesEarnedSol / pos.sol_deployed) * 100;

      if (!liveData.isInRange) {
        await alertOutOfRange(pos.token_symbol, pos.pool_address);
      }

      const decision = await askHealer(pos, {
        ...liveData,
        pnlPct,
        hoursOpen,
      });

      logger.info('Healer decision', {
        symbol: pos.token_symbol,
        action: decision.action,
        urgency: decision.urgency,
      });

      if (decision.action === 'CLAIM_FEES') {
        const claimed = await claimFees(pos.pool_address, pos.position_pubkey ?? '');
        if (claimed.success) {
          addFeesClaimed(pos.id, claimed.feesClaimedSol);
          logger.info('Fees claimed', { sol: claimed.feesClaimedSol });
        }

      } else if (decision.action === 'CLOSE' || decision.action === 'REDEPLOY') {
        const closed = await execClose(pos.pool_address, pos.position_pubkey ?? '');
        if (!closed.success) {
          logger.error('Failed to close position', { error: closed.error });
          continue;
        }

        const feeApr = hoursOpen > 0
          ? (closed.feesClaimedSol / pos.sol_deployed) * (8760 / hoursOpen) * 100
          : 0;
        const inRangePct = liveData.isInRange ? 100 : 50;

        dbClosePosition(pos.id, {
          feesSol:       closed.feesClaimedSol,
          exitPrice:     liveData.currentPrice,
          exitReason:    decision.action === 'REDEPLOY' ? 'redeploy' : 'healer_close',
          feeApr,
          timeInRangePct: inRangePct,
        });

        const posData = { ...pos, fees_claimed_sol: closed.feesClaimedSol,
          fee_apr_pct: feeApr, time_in_range_pct: inRangePct,
          exit_reason: decision.action === 'REDEPLOY' ? 'redeploy' : 'healer_close',
          pnl_pct: pnlPct,
        };
        const lesson = await deriveLesson(posData);
        addLesson(
          decision.action === 'REDEPLOY' ? 'HEALER' : 'GENERAL',
          lesson,
          String(pos.id),
          0.75
        );

        await alertClose({
          symbol:     pos.token_symbol,
          feesSol:    closed.feesClaimedSol,
          pnlPct,
          exitReason: decision.action === 'REDEPLOY' ? 'redeploy' : 'healer_close',
          hoursOpen,
          feeApr,
        });

        // Track consecutive losses for circuit breaker
        if (pnlPct < 0) {
          agentState.consecutiveLosses++;
          logger.warn(`Loss streak: ${agentState.consecutiveLosses}/${agentState.maxConsecutiveLosses}`);
          if (agentState.consecutiveLosses >= agentState.maxConsecutiveLosses) {
            agentState.isRunning = false;
            logger.error('Circuit breaker triggered — auto-paused after consecutive losses');
            await alertEmergencyStop(0);
            return;
          }
          setPoolCooldown(pos.pool_address, 4);
        } else {
          agentState.consecutiveLosses = 0;
        }
      }

    } catch (err) {
      logger.error('Healer error for position', { id: pos.id, err });
    }
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
  });

  const fs   = await import('fs');
  const path = await import('path');
  const dataDir = path.dirname(path.resolve(config.dbPath));
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  initDB();

  const rpcOk = await checkRPHealth();
  if (!rpcOk) {
    logger.error('RPC unhealthy — refusing to start');
    process.exit(1);
  }

  setupCommands(agentState);

  const solBalance = await getSolBalance();
  setState('sol_balance', solBalance.toString());
  recordSolPrice(150); // approximate, override with real SOL/USD oracle if available

  await alertStarted(solBalance);

  cron.schedule(`*/${config.hunterIntervalMin} * * * *`, runHunterCycle);
  cron.schedule(`*/${config.healerIntervalMin} * * * *`, runHealerCycle);
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

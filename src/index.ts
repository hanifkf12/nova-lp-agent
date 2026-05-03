import cron from 'node-cron';
import { config } from './config';
import { logger } from './utils/logger';
import {
  initDB, insertPosition, closePosition as dbClosePosition,
  getOpenPositions, addLesson, setState, getState,
  setPoolCooldown, buildPerformanceMemory,
} from './db';
import { huntPools } from './screening/hunter';
import { askHunter, askHealer, deriveLesson } from './intelligence/llm';
import {
  getSolBalance, deployPosition,
  claimFees, closePosition as execClose,
  getLivePositionData,
} from './execution/dlmm';
import {
  alertStarted, alertDeploy, alertClose,
  alertOutOfRange, alertEmergencyStop,
  sendDailyReport, setupCommands,
} from './notifications/telegram';

const agentState = { isRunning: true };

// ── HUNTER CYCLE — cari dan deploy pool baru ──────────────────

async function runHunterCycle(): Promise<void> {
  if (!agentState.isRunning) return;
  logger.info('═══ Hunter cycle start ═══');

  try {
    const openPositions = getOpenPositions();

    // Jangan deploy kalau sudah max positions
    if (openPositions.length >= config.maxPositions) {
      logger.info('Max positions reached, skipping hunter cycle');
      return;
    }

    const solBalance = await getSolBalance();
    setState('sol_balance', solBalance.toString());

    // Emergency stop check
    const deployed    = openPositions.reduce((s, p) => s + p.sol_deployed, 0);
    const totalValue  = solBalance + deployed;
    const drawdown    = (config.totalCapitalSol - totalValue) / config.totalCapitalSol;

    if (drawdown >= config.maxDrawdownPct) {
      agentState.isRunning = false;
      await alertEmergencyStop(drawdown * 100);
      logger.error('Emergency stop!', { drawdown, totalValue });
      return;
    }

    // Hunt pools
    const candidates = await huntPools();
    if (candidates.length === 0) {
      logger.info('No candidates found this cycle');
      return;
    }

    // Evaluasi top 3 dengan LLM
    for (const candidate of candidates.slice(0, 3)) {
      if (openPositions.length >= config.maxPositions) break;
      if (solBalance < config.minPositionSol + 0.1) {
        logger.warn('SOL balance too low to deploy');
        break;
      }

      const decision = await askHunter(
        candidate,
        openPositions.length,
        solBalance,
      );

      if (decision.action !== 'DEPLOY' || decision.confidence < 0.65) {
        logger.info(`Skip ${candidate.tokenSymbol}`, {
          reason: decision.reasoning.slice(0, 60),
        });
        continue;
      }

      // Execute deploy
      const strategy  = config.lpStrategy === 'auto' ? decision.strategy : config.lpStrategy;
      const result    = await deployPosition(
        candidate.poolAddress,
        strategy,
        Math.min(decision.solAmount, solBalance - 0.1),
        decision.binRange,
      );

      if (!result.success) {
        logger.error('Deploy failed', { error: result.error });
        continue;
      }

      // Save to DB
      const posId = insertPosition({
        poolAddress:   candidate.poolAddress,
        tokenMint:     candidate.tokenMint,
        tokenSymbol:   candidate.tokenSymbol,
        binStep:       candidate.binStep,
        strategy,
        solDeployed:   decision.solAmount,
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

      logger.info('Position opened', { posId, symbol: candidate.tokenSymbol });

      await alertDeploy({
        symbol:      candidate.tokenSymbol,
        poolAddress: candidate.poolAddress,
        solAmount:   decision.solAmount,
        strategy,
        novaScore:   candidate.novaScore,
        confidence:  decision.confidence,
        reasoning:   decision.reasoning,
        feeTvlRatio: candidate.feeTvlRatio,
      });

      // Update balance
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

      // Alert kalau out of range
      if (!liveData.isInRange) {
        await alertOutOfRange(pos.token_symbol, pos.pool_address);
      }

      // Ask healer LLM
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
        const inRangePct = liveData.isInRange ? 100 : 50; // simplified

        // Close in DB
        dbClosePosition(pos.id, {
          feesSol:       closed.feesClaimedSol,
          exitPrice:     liveData.currentPrice,
          exitReason:    decision.action === 'REDEPLOY' ? 'redeploy' : 'healer_close',
          feeApr,
          timeInRangePct: inRangePct,
        });

        // Derive lesson
        const posData   = { ...pos, fees_claimed_sol: closed.feesClaimedSol,
          fee_apr_pct: feeApr, time_in_range_pct: inRangePct,
          exit_reason: decision.action === 'REDEPLOY' ? 'redeploy' : 'healer_close',
          pnl_pct: pnlPct,
        };
        const lesson    = await deriveLesson(posData);
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

        // Set cooldown kalau loss
        if (pnlPct < 0) {
          setPoolCooldown(pos.pool_address, 4); // cooldown 4 jam
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

  // Ensure directories
  const fs   = await import('fs');
  const path = await import('path');
  const dataDir = path.dirname(path.resolve(config.dbPath));
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Init DB
  initDB();

  // Setup Telegram
  setupCommands(agentState);

  // Initial balance
  const solBalance = await getSolBalance();
  setState('sol_balance', solBalance.toString());

  await alertStarted(solBalance);

  // Schedule hunter (scan pool baru)
  cron.schedule(`*/${config.hunterIntervalMin} * * * *`, runHunterCycle);

  // Schedule healer (monitor posisi)
  cron.schedule(`*/${config.healerIntervalMin} * * * *`, runHealerCycle);

  // Daily report
  cron.schedule(`0 ${config.dailyReportHourUtc} * * *`, sendDailyReport);

  // Run first cycles immediately
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

// Manual CLI for one-shot operations (no cron, no Telegram).
// Usage:
//   npm run screen     → scan pools now, print top candidates
//   npm run stats      → show performance + recent closes
//   npm run positions  → list open positions
//   npm run lessons    → manage the lessons table (list / show / delete / prune)
//   npm run backtest   → backfill OHLCV + run strategy backtest on a pool

import { initDB, getOpenPositions, buildPerformanceMemory, db } from './db';
import { huntPools } from './screening/hunter';
import { logger } from './utils/logger';
import { refreshSolPriceUsd } from './utils/solPrice';
import { backfillFromOhlcv } from './backtest/ohlcv';
import {
  getSnapshots, runBacktest, optimizeScoreWeight, recordBacktestRun,
} from './backtest/engine';
import { config } from './config';

async function cmdScreen(): Promise<void> {
  initDB();
  const pools = await huntPools();
  if (pools.length === 0) {
    console.log('No qualified candidates.');
    return;
  }
  console.log(`\nTop ${Math.min(10, pools.length)} candidates:\n`);
  console.log('Score  Symbol         Fee/TVL  Vol24h     TVL        Risk    Pool');
  console.log('─────  ─────────────  ───────  ─────────  ─────────  ──────  ────');
  for (const p of pools.slice(0, 10)) {
    const fmt = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(0)}K`.padEnd(8) : `$${n.toFixed(0)}`.padEnd(8);
    console.log(
      `${p.novaScore.toFixed(0).padStart(5)}  ` +
      `${p.tokenSymbol.padEnd(13)}  ` +
      `${(p.feeTvlRatio).toFixed(2).padStart(6)}%  ` +
      `${fmt(p.volume24hUsd)} ` +
      `${fmt(p.tvlUsd)} ` +
      `${p.riskLevel.padEnd(6)}  ` +
      `${p.poolAddress.slice(0, 12)}...`
    );
  }
}

function cmdStats(): void {
  initDB();
  const perf = buildPerformanceMemory();
  console.log('\n═══ Nova LP Agent Stats ═══\n');
  console.log(`Total closed   : ${perf.stats?.total ?? 0}`);
  console.log(`Win rate       : ${perf.winRatePct}%`);
  console.log(`Avg PnL %      : ${perf.stats?.avg_pnl_pct ?? 0}%`);
  console.log(`Avg fee APR    : ${perf.stats?.avg_fee_apr ?? 0}%`);
  console.log(`Total PnL SOL  : ${perf.stats?.total_pnl_sol ?? 0}`);
  console.log(`Avg time-in-range: ${perf.stats?.avg_time_in_range ?? 0}%`);
  console.log('\nBy exit reason:');
  for (const e of perf.byExit) {
    console.log(`  ${(e.exit_reason ?? 'unknown').padEnd(16)} n=${e.n}  avg=${e.avg_pnl}%`);
  }
  console.log('\nRecent trades:');
  console.log(perf.recentTrades);
}

function cmdPositions(): void {
  initDB();
  const open = getOpenPositions();
  if (open.length === 0) {
    console.log('No open positions.');
    return;
  }
  console.log(`\n${open.length} open position(s):\n`);
  for (const p of open) {
    const hours = (Date.now() - p.opened_at) / 3600000;
    console.log(
      `#${p.id} ${p.token_symbol} [${p.strategy}]\n` +
      `   Deployed : ${p.sol_deployed.toFixed(4)} SOL  (${hours.toFixed(1)}h ago)\n` +
      `   Fees     : ${(p.fees_claimed_sol ?? 0).toFixed(6)} SOL\n` +
      `   Pool     : ${p.pool_address}\n` +
      `   Position : ${p.position_pubkey ?? '?'}\n`
    );
  }
}

async function cmdSolPrice(): Promise<void> {
  initDB();
  const p = await refreshSolPriceUsd();
  console.log(`SOL = $${p.toFixed(2)}`);
}

function cmdLessons(args: string[]): void {
  initDB();
  const sub = args[0] ?? 'list';

  if (sub === 'list') {
    const rows = db.prepare(`
      SELECT id, role, content, confidence, created_at, source
      FROM lessons ORDER BY id DESC
    `).all() as any[];
    if (rows.length === 0) { console.log('No lessons in DB.'); return; }
    console.log(`\n${rows.length} lesson(s):\n`);
    console.log('  ID  Role     Age   Conf  Src     PnL    Content');
    console.log('────  ───────  ────  ────  ──────  ─────  ────────────────────────────────────────────');
    for (const r of rows) {
      const ageH = Math.floor((Date.now() - r.created_at) / 3600000);
      const age  = ageH < 24 ? `${ageH}h` : `${Math.floor(ageH / 24)}d`;
      let pnlTag = '   -';
      if (r.source) {
        const src = db.prepare('SELECT pnl_sol FROM positions WHERE id = ?').get(Number(r.source)) as any;
        if (src && src.pnl_sol !== null) pnlTag = (src.pnl_sol >= 0 ? '+' : '') + src.pnl_sol.toFixed(2);
      }
      console.log(
        `${String(r.id).padStart(4)}  ` +
        `${(r.role ?? '').padEnd(7)}  ` +
        `${age.padEnd(4)}  ` +
        `${r.confidence.toFixed(2).padEnd(4)}  ` +
        `${(r.source ?? '-').padEnd(6)}  ` +
        `${pnlTag.padEnd(5)}  ` +
        r.content.slice(0, 90)
      );
    }
    console.log('\nTip: `npm run lessons -- show <id>` to read full text, `delete <id>` to remove one.');
    return;
  }

  if (sub === 'show') {
    const id = Number(args[1] ?? 0);
    if (!id) { console.error('Usage: npm run lessons -- show <id>'); return; }
    const row = db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as any;
    if (!row) { console.log(`No lesson with id ${id}.`); return; }
    console.log(`\n#${row.id}  role=${row.role}  conf=${row.confidence}  source=${row.source ?? '-'}`);
    console.log(`Created: ${new Date(row.created_at).toISOString()}\n`);
    console.log(row.content);
    console.log('');
    return;
  }

  if (sub === 'delete') {
    const id = Number(args[1] ?? 0);
    if (!id) { console.error('Usage: npm run lessons -- delete <id>'); return; }
    const result = db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
    console.log(`Deleted ${result.changes} lesson(s).`);
    return;
  }

  if (sub === 'prune-losing') {
    // Lessons whose source is a position that closed at a loss
    const result = db.prepare(`
      DELETE FROM lessons
      WHERE source IS NOT NULL
        AND CAST(source AS INTEGER) IN (
          SELECT id FROM positions WHERE status = 'closed' AND pnl_sol < 0
        )
    `).run();
    console.log(`Deleted ${result.changes} lesson(s) sourced from losing positions.`);
    return;
  }

  if (sub === 'prune-pool') {
    const pool = args[1];
    if (!pool) { console.error('Usage: npm run lessons -- prune-pool <pool_address>'); return; }
    const result = db.prepare(`
      DELETE FROM lessons
      WHERE source IS NOT NULL
        AND CAST(source AS INTEGER) IN (
          SELECT id FROM positions WHERE pool_address = ?
        )
    `).run(pool);
    console.log(`Deleted ${result.changes} lesson(s) sourced from positions on pool ${pool}.`);
    return;
  }

  if (sub === 'prune-all') {
    if (!args.includes('--yes')) {
      console.error('This will delete ALL lessons. Re-run with --yes to confirm:');
      console.error('  npm run lessons -- prune-all --yes');
      return;
    }
    const result = db.prepare('DELETE FROM lessons').run();
    console.log(`Deleted ${result.changes} lesson(s). Table is now empty.`);
    return;
  }

  console.log(
    'Usage:\n' +
    '  npm run lessons                       list all lessons\n' +
    '  npm run lessons -- show <id>          print full lesson content\n' +
    '  npm run lessons -- delete <id>        delete one lesson\n' +
    '  npm run lessons -- prune-losing       delete lessons sourced from losing positions\n' +
    '  npm run lessons -- prune-pool <addr>  delete lessons sourced from one pool\n' +
    '  npm run lessons -- prune-all --yes    delete ALL lessons'
  );
}

function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.findIndex(a => a === `--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

async function cmdBacktest(args: string[]): Promise<void> {
  initDB();
  const pool   = getArg(args, 'pool');
  const days   = Number(getArg(args, 'days', '14'));
  const sol    = Number(getArg(args, 'sol',  String(config.maxPositionSol)));
  const bins   = Number(getArg(args, 'bins', String(config.binRange)));
  const sweep  = args.includes('--sweep');
  const skipBackfill = args.includes('--no-backfill');

  if (!pool) {
    console.error('Usage: npm run backtest -- --pool <address> [--days 14] [--sol 0.4] [--bins 69] [--sweep] [--no-backfill]');
    return;
  }

  let symbol = '?';
  if (!skipBackfill) {
    console.log(`Backfilling OHLCV for ${pool} (${days} days)...`);
    const r = await backfillFromOhlcv(pool, days);
    symbol = r.symbol;
    console.log(`  Inserted ${r.inserted} candles for ${symbol}.\n`);
  }

  const since = Date.now() - days * 86400000;
  const snaps = getSnapshots(pool, since, Date.now());
  if (snaps.length === 0) {
    console.error('No snapshots in window. Run without --no-backfill first.');
    return;
  }

  // Estimate bin step from any pool detail call could go here; fall back to a typical 25.
  const binStep = 25;

  if (sweep) {
    console.log(`Sweeping score thresholds (40..95) on ${snaps.length} snapshots...\n`);
    const { bestThreshold, bestResult } = optimizeScoreWeight(snaps, {
      solPerPosition: sol, binCount: bins, binStep,
    });
    console.log(`\nBest threshold: ${bestThreshold}`);
    console.log(`  Positions  : ${bestResult.positions}`);
    console.log(`  Win rate   : ${(bestResult.wins / Math.max(1, bestResult.positions) * 100).toFixed(1)}%`);
    console.log(`  Total PnL  : ${bestResult.totalPnLSol.toFixed(4)} SOL`);
    console.log(`  Avg APR    : ${bestResult.avgApr.toFixed(1)}%`);
    console.log(`  Max DD     : ${(bestResult.maxDrawdown * 100).toFixed(1)}%`);
    recordBacktestRun(bestResult);
  } else {
    const result = runBacktest(snaps, {
      scoreThreshold: 65, solPerPosition: sol, binCount: bins, binStep,
    });
    console.log(`\n═══ Backtest: ${symbol} (${pool.slice(0, 8)}...) ═══`);
    console.log(`Sample        : ${snaps.length} snapshots over ${days} days`);
    console.log(`Positions     : ${result.positions}`);
    console.log(`Wins / Losses : ${result.wins} / ${result.losses}`);
    console.log(`Win rate      : ${(result.wins / Math.max(1, result.positions) * 100).toFixed(1)}%`);
    console.log(`Total PnL SOL : ${result.totalPnLSol >= 0 ? '+' : ''}${result.totalPnLSol.toFixed(4)}`);
    console.log(`Total fees    : ${result.totalFeesSol.toFixed(4)} SOL`);
    console.log(`Avg APR       : ${result.avgApr.toFixed(1)}%`);
    console.log(`Max drawdown  : ${(result.maxDrawdown * 100).toFixed(1)}%`);
    recordBacktestRun(result);
  }
}

const cmd = process.argv[2] ?? 'help';
const rest = process.argv.slice(3);
(async () => {
  try {
    switch (cmd) {
      case 'screen':    await cmdScreen();      break;
      case 'stats':     cmdStats();             break;
      case 'positions': cmdPositions();         break;
      case 'solprice':  await cmdSolPrice();    break;
      case 'lessons':   cmdLessons(rest);       break;
      case 'backtest':  await cmdBacktest(rest); break;
      default:
        console.log('Usage: ts-node src/cli.ts <screen|stats|positions|solprice|lessons|backtest>');
    }
  } catch (err) {
    logger.error('CLI error', { err });
    process.exit(1);
  } finally {
    setTimeout(() => process.exit(0), 200);
  }
})();

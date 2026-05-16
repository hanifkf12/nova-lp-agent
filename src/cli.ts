// Manual CLI for one-shot operations (no cron, no Telegram).
// Usage:
//   npm run screen     → scan pools now, print top candidates
//   npm run stats      → show performance + recent closes
//   npm run positions  → list open positions

import { initDB, getOpenPositions, buildPerformanceMemory } from './db';
import { huntPools } from './screening/hunter';
import { logger } from './utils/logger';
import { refreshSolPriceUsd } from './utils/solPrice';

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

const cmd = process.argv[2] ?? 'help';
(async () => {
  try {
    switch (cmd) {
      case 'screen':    await cmdScreen();    break;
      case 'stats':     cmdStats();           break;
      case 'positions': cmdPositions();       break;
      case 'solprice':  await cmdSolPrice();  break;
      default:
        console.log('Usage: ts-node src/cli.ts <screen|stats|positions|solprice>');
    }
  } catch (err) {
    logger.error('CLI error', { err });
    process.exit(1);
  } finally {
    setTimeout(() => process.exit(0), 200);
  }
})();

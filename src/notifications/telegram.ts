import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { logger } from '../utils/logger';
import { db, getOpenPositions, buildPerformanceMemory, getState } from '../db';
import { getLivePositionData } from '../execution/dlmm';

let _bot: TelegramBot | null = null;

function getBot(): TelegramBot {
  if (!_bot) _bot = new TelegramBot(config.telegramToken, { polling: false });
  return _bot;
}

async function send(text: string): Promise<void> {
  try {
    await getBot().sendMessage(config.telegramChatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    logger.error('Telegram send failed', { err });
  }
}

function usd(sol: number): string {
  const solPriceUsd = parseFloat(getState('sol_price_usd') ?? '0');
  if (!solPriceUsd) return '?';
  const v = sol * solPriceUsd;
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Legacy Markdown has no backslash-escape — strip the four formatting chars
// (`_`, `*`, backtick, `[`) from dynamic content before interpolation.
function md(s: unknown): string {
  return String(s ?? '').replace(/[_*`\[\]]/g, ' ');
}

// ── Alerts ─────────────────────────────────────────────────────

export async function alertStarted(solBal: number): Promise<void> {
  await send(
    `🔱 *Nova LP Agent Started*\n` +
    `Mode    : ${config.dryRun ? 'Dry Run 🔵' : 'Live 🔴'}\n` +
    `Balance : ${solBal.toFixed(4)} SOL\n` +
    `Hunter  : setiap ${config.hunterIntervalMin} menit\n` +
    `Healer  : setiap ${config.healerIntervalMin} menit`
  );
}

export async function alertDeploy(params: {
  symbol:       string;
  poolAddress:  string;
  solAmount:    number;
  strategy:     string;
  novaScore:    number;
  confidence:   number;
  reasoning:    string;
  feeTvlRatio:  number;
}): Promise<void> {
  const p = params;

  await send(
    `🟢 *LP DEPLOYED${config.dryRun ? ' [DRY]' : ''}*\n` +
    `Token    : ${md(p.symbol)}\n` +
    `Strategy : ${md(p.strategy.toUpperCase())}\n` +
    `Amount   : ${p.solAmount.toFixed(4)} SOL ($${usd(p.solAmount)})\n` +
    `Nova Score: ${p.novaScore.toFixed(1)}/100\n` +
    `Fee/TVL  : ${(p.feeTvlRatio).toFixed(2)}%\n` +
    `Confidence: ${Math.round(p.confidence * 100)}%\n` +
    `Reasoning: _${md(p.reasoning)}_\n` +
    `Pool: \`${p.poolAddress.slice(0, 20)}...\``
  );
}

export async function alertClose(params: {
  symbol:      string;
  feesSol:     number;
  pnlPct:      number;
  exitReason:  string;
  hoursOpen:   number;
  feeApr:      number;
}): Promise<void> {
  const p = params;
  const emoji   = p.feesSol >= 0 ? '✅' : '❌';
  const sign    = p.feesSol >= 0 ? '+' : '';

  await send(
    `${emoji} *LP CLOSED${config.dryRun ? ' [DRY]' : ''}*\n` +
    `Token    : ${md(p.symbol)}\n` +
    `Fees     : ${sign}${p.feesSol.toFixed(6)} SOL (${sign}$${usd(p.feesSol)})\n` +
    `PnL      : ${sign}${p.pnlPct.toFixed(2)}%\n` +
    `Fee APR  : ${p.feeApr.toFixed(1)}%\n` +
    `Duration : ${p.hoursOpen.toFixed(1)} jam\n` +
    `Reason   : ${md(p.exitReason)}`
  );
}

export async function alertOutOfRange(symbol: string, poolAddress: string): Promise<void> {
  await send(
    `⚠️ *OUT OF RANGE*\n` +
    `Token: ${md(symbol)}\n` +
    `Pool: \`${poolAddress.slice(0, 20)}...\`\n` +
    `Posisi tidak earning fee — agent akan evaluasi.`
  );
}

export async function alertEmergencyStop(drawdownPct: number): Promise<void> {
  await send(
    `🚨 *EMERGENCY STOP*\n` +
    `Drawdown ${drawdownPct.toFixed(1)}% mencapai batas ${config.maxDrawdownPct * 100}%.\n` +
    `Semua posisi akan ditutup. Agent dihentikan.`
  );
}

export async function sendDailyReport(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const perf  = buildPerformanceMemory();

  const dayStats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(fees_claimed_sol),6) as fees,
      ROUND(AVG(fee_apr_pct),1) as avg_apr
    FROM positions
    WHERE status='closed' AND date(closed_at/1000,'unixepoch') = ?
  `).get(today) as any;

  const openPos  = getOpenPositions();
  const solBal   = parseFloat(getState('sol_balance') ?? '0');
  const dayFees  = dayStats?.fees ?? 0;
  const emoji    = dayFees >= 0 ? '📈' : '📉';

  await send(
    `${emoji} *Daily Report — ${today}*\n\n` +
    `*Hari ini:*\n` +
    `Closed  : ${dayStats?.total ?? 0} posisi (${dayStats?.wins ?? 0}W)\n` +
    `Fees    : +${dayFees} SOL ($${usd(dayFees)})\n` +
    `Avg APR : ${dayStats?.avg_apr ?? 0}%\n\n` +
    `*All-time:*\n` +
    `Total   : ${perf.stats?.total ?? 0} | WR: ${perf.winRatePct}%\n` +
    `Total fees: ${perf.stats?.total_pnl_sol?.toFixed(6) ?? 0} SOL\n\n` +
    `Open now: ${openPos.length} posisi\n` +
    `Balance : ${solBal.toFixed(4)} SOL`
  );
}

// ── Commands ───────────────────────────────────────────────────

export function setupCommands(agentState: { isRunning: boolean }): void {
  const polBot = new TelegramBot(config.telegramToken, { polling: true });
  const guard  = (msg: TelegramBot.Message) =>
    msg.chat.id.toString() === config.telegramChatId;

  polBot.onText(/\/status/, async (msg) => {
    if (!guard(msg)) return;
    const perf    = buildPerformanceMemory();
    const openPos = getOpenPositions();
    const solBal  = parseFloat(getState('sol_balance') ?? '0');

    await polBot.sendMessage(msg.chat.id,
      `🔱 *Nova LP Agent*\n` +
      `Running  : ${agentState.isRunning ? '✅' : '⏸'}\n` +
      `Mode     : ${config.dryRun ? 'Dry Run' : 'Live'}\n` +
      `Balance  : ${solBal.toFixed(4)} SOL\n` +
      `Open pos : ${openPos.length}/${config.maxPositions}\n\n` +
      `*Performance:*\n` +
      `Trades   : ${perf.stats?.total ?? 0} | WR: ${perf.winRatePct}%\n` +
      `Avg APR  : ${perf.stats?.avg_fee_apr ?? 0}%\n` +
      `Total PnL: +${perf.stats?.total_pnl_sol?.toFixed(6) ?? 0} SOL`,
      { parse_mode: 'Markdown' }
    );
  });

  polBot.onText(/\/positions/, async (msg) => {
    if (!guard(msg)) return;
    const positions = getOpenPositions();
    if (positions.length === 0) {
      await polBot.sendMessage(msg.chat.id, 'No open positions.');
      return;
    }

    const live = await Promise.all(positions.map(p =>
      getLivePositionData(p.pool_address, p.position_pubkey ?? '', p.entry_price ?? 0, p.sol_deployed ?? 0)
        .catch(() => null)
    ));

    const blocks = positions.map((p, i) => {
      const ld           = live[i];
      const hoursOpen    = (Date.now() - p.opened_at) / 3600000;
      const claimedFees  = p.fees_claimed_sol ?? 0;
      const pendingFees  = ld?.feesEarnedSol ?? 0;
      const totalFees    = claimedFees + pendingFees;
      const totalValue   = (ld?.positionValueSol ?? p.sol_deployed) + pendingFees;
      const pnlPct       = p.sol_deployed > 0
        ? ((totalValue - p.sol_deployed) / p.sol_deployed) * 100
        : 0;
      const sign         = pnlPct >= 0 ? '+' : '';
      const rangeEmoji   = ld?.isInRange === false ? '⚠️ OOR' : ld?.isInRange ? '✅ in-range' : '❔ no data';
      const currentPrice = ld?.currentPrice ?? p.entry_price ?? 0;
      const priceMove    = p.entry_price > 0 ? ((currentPrice - p.entry_price) / p.entry_price) * 100 : 0;
      const priceSign    = priceMove >= 0 ? '+' : '';

      return (
        `*${i + 1}. ${md(p.token_symbol)}* (#${p.id}) _${md(p.strategy)}_\n` +
        `Status   : ${rangeEmoji} | ${hoursOpen.toFixed(1)}h open\n` +
        `Deployed : ${p.sol_deployed.toFixed(4)} SOL\n` +
        `Value    : ${totalValue.toFixed(4)} SOL (${sign}${pnlPct.toFixed(2)}%)\n` +
        `Fees     : ${totalFees.toFixed(6)} SOL  (claimed ${claimedFees.toFixed(6)} + pending ${pendingFees.toFixed(6)})\n` +
        `Entry    : ${(p.entry_price ?? 0).toPrecision(4)}\n` +
        `Current  : ${currentPrice.toPrecision(4)} (${priceSign}${priceMove.toFixed(2)}%)\n` +
        `Range    : ${(p.price_range_min ?? 0).toPrecision(4)} → ${(p.price_range_max ?? 0).toPrecision(4)}\n` +
        `Pool     : \`${p.pool_address.slice(0, 16)}...\``
      );
    });

    await polBot.sendMessage(
      msg.chat.id,
      `*Open Positions (${positions.length}):*\n\n${blocks.join('\n\n')}`,
      { parse_mode: 'Markdown' }
    );
  });

  polBot.onText(/\/stop/, async (msg) => {
    if (!guard(msg)) return;
    agentState.isRunning = false;
    await polBot.sendMessage(msg.chat.id, '⏸ Agent paused. /start untuk lanjut.');
  });

  polBot.onText(/\/start/, async (msg) => {
    if (!guard(msg)) return;
    agentState.isRunning = true;
    await polBot.sendMessage(msg.chat.id, '▶️ Agent running.');
  });

  polBot.onText(/\/report/, async (msg) => {
    if (!guard(msg)) return;
    await sendDailyReport();
  });

  polBot.onText(/\/closeall/, async (msg) => {
    if (!guard(msg)) return;
    await polBot.sendMessage(msg.chat.id, '⚠️ Closing all positions...');
    // Signal handled by main loop
    agentState.isRunning = false;
  });

  logger.info('Telegram commands: /status /positions /stop /start /report /closeall');
}

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';

const dbDir = path.dirname(path.resolve(config.dbPath));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

export const db = new Database(path.resolve(config.dbPath));

export function initDB(): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- Setiap posisi LP yang pernah dibuka
    CREATE TABLE IF NOT EXISTS positions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      opened_at       INTEGER NOT NULL,
      closed_at       INTEGER,

      -- Pool info
      pool_address    TEXT NOT NULL,
      token_mint      TEXT NOT NULL,
      token_symbol    TEXT NOT NULL,
      bin_step        INTEGER,
      strategy        TEXT,           -- spot | curve | bid_ask

      -- Entry data
      sol_deployed    REAL NOT NULL,
      entry_price     REAL,
      price_range_min REAL,
      price_range_max REAL,
      bin_count       INTEGER,

      -- Performance
      fees_claimed_sol REAL DEFAULT 0,
      exit_price       REAL,
      pnl_sol          REAL,          -- fees - IL
      pnl_pct          REAL,
      fee_apr_pct      REAL,
      time_in_range_pct REAL,         -- % waktu posisi aktif
      exit_reason      TEXT,          -- take_profit|stop_loss|out_of_range|manual|redeploy

      -- Screening signals at entry
      tvl_usd         REAL,
      volume_24h_usd  REAL,
      fee_tvl_ratio   REAL,
      organic_score   REAL,
      holder_count    INTEGER,
      mcap_usd        REAL,
      whale_present   INTEGER DEFAULT 0,
      kol_present     INTEGER DEFAULT 0,
      bundle_pct      REAL,
      was_wash        INTEGER DEFAULT 0,

      -- LLM
      llm_reasoning   TEXT,
      llm_confidence  REAL,
      deploy_score    REAL,           -- composite score 0–100

      -- Metadata
      position_pubkey TEXT,
      status          TEXT DEFAULT 'open'  -- open | closed
    );

    -- Lessons yang dipelajari agent
    CREATE TABLE IF NOT EXISTS lessons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  INTEGER NOT NULL,
      role        TEXT NOT NULL,      -- HUNTER | HEALER | GENERAL
      content     TEXT NOT NULL,
      source      TEXT,               -- position_id atau manual
      confidence  REAL DEFAULT 0.5,
      applies_to  TEXT                -- token_type, pool_type, dll
    );

    -- Memory per pool — untuk cooldown dan history
    CREATE TABLE IF NOT EXISTS pool_memory (
      pool_address   TEXT PRIMARY KEY,
      last_deployed  INTEGER,
      deploy_count   INTEGER DEFAULT 0,
      total_pnl_sol  REAL DEFAULT 0,
      win_count      INTEGER DEFAULT 0,
      loss_count     INTEGER DEFAULT 0,
      notes          TEXT,
      cooldown_until INTEGER DEFAULT 0
    );

    -- Whale/smart wallet yang ditrack
    CREATE TABLE IF NOT EXISTS smart_wallets (
      address         TEXT PRIMARY KEY,
      label           TEXT,
      win_rate_pct    REAL,
      avg_hold_hours  REAL,
      total_positions INTEGER DEFAULT 0,
      last_seen       INTEGER,
      source          TEXT    -- manual | auto_discovered
    );

    -- State agent
    CREATE TABLE IF NOT EXISTS agent_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Screening thresholds yang berevolusi
    CREATE TABLE IF NOT EXISTS threshold_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   INTEGER NOT NULL,
      reason      TEXT,
      thresholds  TEXT    -- JSON snapshot
    );

    CREATE INDEX IF NOT EXISTS idx_pos_status   ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_pos_opened   ON positions(opened_at);
    CREATE INDEX IF NOT EXISTS idx_pos_pool     ON positions(pool_address);
    CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role);
  `);
}

// ── Position helpers ───────────────────────────────────────────

export interface PositionInsert {
  poolAddress:    string;
  tokenMint:      string;
  tokenSymbol:    string;
  binStep:        number;
  strategy:       string;
  solDeployed:    number;
  entryPrice:     number;
  priceRangeMin:  number;
  priceRangeMax:  number;
  binCount:       number;
  tvlUsd:         number;
  volume24hUsd:   number;
  feeTvlRatio:    number;
  organicScore:   number;
  holderCount:    number;
  mcapUsd:        number;
  whalePresent:   boolean;
  kolPresent:     boolean;
  bundlePct:      number;
  llmReasoning:   string;
  llmConfidence:  number;
  deployScore:    number;
  positionPubkey?: string;
}

export function insertPosition(p: PositionInsert): number {
  const stmt = db.prepare(`
    INSERT INTO positions (
      opened_at, pool_address, token_mint, token_symbol, bin_step, strategy,
      sol_deployed, entry_price, price_range_min, price_range_max, bin_count,
      tvl_usd, volume_24h_usd, fee_tvl_ratio, organic_score, holder_count,
      mcap_usd, whale_present, kol_present, bundle_pct,
      llm_reasoning, llm_confidence, deploy_score, position_pubkey, status
    ) VALUES (
      @openedAt, @poolAddress, @tokenMint, @tokenSymbol, @binStep, @strategy,
      @solDeployed, @entryPrice, @priceRangeMin, @priceRangeMax, @binCount,
      @tvlUsd, @volume24hUsd, @feeTvlRatio, @organicScore, @holderCount,
      @mcapUsd, @whalePresent, @kolPresent, @bundlePct,
      @llmReasoning, @llmConfidence, @deployScore, @positionPubkey, 'open'
    )
  `);
  const r = stmt.run({
    openedAt: Date.now(),
    ...p,
    whalePresent: p.whalePresent ? 1 : 0,
    kolPresent:   p.kolPresent   ? 1 : 0,
  });
  return r.lastInsertRowid as number;
}

export function closePosition(
  posId: number,
  params: {
    feesSol:       number;
    exitPrice:     number;
    exitReason:    string;
    feeApr:        number;
    timeInRangePct: number;
  }
): void {
  const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(posId) as any;
  if (!pos) return;

  // PnL = fees earned - impermanent loss approximation
  const pnlSol = params.feesSol; // simplified — IL calculated separately
  const pnlPct = (pnlSol / pos.sol_deployed) * 100;

  db.prepare(`
    UPDATE positions SET
      closed_at = ?, fees_claimed_sol = ?, exit_price = ?,
      pnl_sol = ?, pnl_pct = ?, fee_apr_pct = ?,
      time_in_range_pct = ?, exit_reason = ?, status = 'closed'
    WHERE id = ?
  `).run(
    Date.now(), params.feesSol, params.exitPrice,
    pnlSol, pnlPct, params.feeApr,
    params.timeInRangePct, params.exitReason, posId
  );

  // Update pool memory
  updatePoolMemory(pos.pool_address, pnlSol > 0);
}

export function getOpenPositions(): any[] {
  return db.prepare(
    `SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC`
  ).all() as any[];
}

// ── Pool memory ────────────────────────────────────────────────

export function updatePoolMemory(poolAddress: string, win: boolean): void {
  const existing = db.prepare('SELECT * FROM pool_memory WHERE pool_address = ?').get(poolAddress) as any;
  if (existing) {
    db.prepare(`
      UPDATE pool_memory SET
        last_deployed = ?, deploy_count = deploy_count + 1,
        win_count  = win_count  + ?,
        loss_count = loss_count + ?
      WHERE pool_address = ?
    `).run(Date.now(), win ? 1 : 0, win ? 0 : 1, poolAddress);
  } else {
    db.prepare(`
      INSERT INTO pool_memory (pool_address, last_deployed, deploy_count, win_count, loss_count)
      VALUES (?, ?, 1, ?, ?)
    `).run(poolAddress, Date.now(), win ? 1 : 0, win ? 0 : 1);
  }
}

export function setPoolCooldown(poolAddress: string, hours: number): void {
  const until = Date.now() + hours * 3600000;
  db.prepare(`
    INSERT OR REPLACE INTO pool_memory (pool_address, cooldown_until, last_deployed)
    VALUES (?, ?, ?)
    ON CONFLICT(pool_address) DO UPDATE SET cooldown_until = ?
  `).run(poolAddress, until, Date.now(), until);
}

export function isPoolOnCooldown(poolAddress: string): boolean {
  const mem = db.prepare('SELECT cooldown_until FROM pool_memory WHERE pool_address = ?').get(poolAddress) as any;
  return mem ? (mem.cooldown_until ?? 0) > Date.now() : false;
}

// ── Lessons ────────────────────────────────────────────────────

export function addLesson(role: string, content: string, source?: string, confidence = 0.7): void {
  db.prepare(`
    INSERT INTO lessons (created_at, role, content, source, confidence)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), role, content, source ?? null, confidence);
}

export function getLessons(role: string, limit = 10): string[] {
  const rows = db.prepare(`
    SELECT content FROM lessons
    WHERE role = ? OR role = 'GENERAL'
    ORDER BY confidence DESC, created_at DESC
    LIMIT ?
  `).all(role, limit) as any[];
  return rows.map(r => r.content);
}

// ── Performance memory ─────────────────────────────────────────

export function buildPerformanceMemory() {
  const stats = db.prepare(`
    SELECT
      COUNT(*)                                      as total,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(AVG(pnl_pct), 3)                        as avg_pnl_pct,
      ROUND(SUM(pnl_sol), 6)                        as total_pnl_sol,
      ROUND(AVG(fee_apr_pct), 1)                    as avg_fee_apr,
      ROUND(AVG(time_in_range_pct), 1)              as avg_time_in_range
    FROM positions WHERE status = 'closed'
  `).get() as any;

  const byExit = db.prepare(`
    SELECT exit_reason, COUNT(*) as n, ROUND(AVG(pnl_pct),2) as avg_pnl
    FROM positions WHERE status='closed'
    GROUP BY exit_reason
  `).all() as any[];

  const recent = db.prepare(`
    SELECT token_symbol, pnl_pct, exit_reason, fee_tvl_ratio, strategy,
           datetime(opened_at/1000,'unixepoch','localtime') as dt
    FROM positions WHERE status='closed'
    ORDER BY opened_at DESC LIMIT 5
  `).all() as any[];

  const total = stats?.total ?? 0;
  return {
    stats,
    winRatePct: total > 0 ? Math.round((stats.wins / total) * 100) : 0,
    byExit,
    recentTrades: recent.map(r =>
      `${r.dt}: ${r.token_symbol} [${r.strategy}] → ${r.pnl_pct >= 0 ? '+' : ''}${r.pnl_pct?.toFixed(2)}% (${r.exit_reason})`
    ).join('\n') || 'Belum ada posisi tertutup.',
  };
}

// ── State helpers ──────────────────────────────────────────────

export function getState(k: string): string | null {
  const r = db.prepare('SELECT value FROM agent_state WHERE key=?').get(k) as any;
  return r?.value ?? null;
}
export function setState(k: string, v: string): void {
  db.prepare('INSERT OR REPLACE INTO agent_state (key,value) VALUES (?,?)').run(k, v);
}

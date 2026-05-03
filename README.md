# Nova LP Agent 🔱

Autonomous Meteora DLMM liquidity provider agent — more powerful than Meridian.
Built with TypeScript, Claude Sonnet, multi-layer risk scoring, and self-learning memory.

## Keunggulan vs Meridian

| Feature | Meridian | Nova LP |
|---|---|---|
| Language | JavaScript | **TypeScript** (type-safe) |
| LLM | OpenAI format | **Claude Sonnet** (reasoning lebih dalam) |
| Screening | Meteora + OKX | **+ Birdeye + Helius whale tracking** |
| Risk scoring | Basic flags | **Nova Score: composite 0–100** |
| Database | JSON files | **SQLite** (query kompleks, analytics) |
| Position exit | Basic SL/TP | **Dynamic healer + fee yield scoring** |
| Whale tracking | Smart wallets | **Real-time Helius on-chain** |
| Self-learning | Lesson text | **LLM-derived structured lessons per position** |
| Pool cooldown | Manual | **Auto-cooldown setelah loss** |
| Logging | Console | **Winston: file + console** |

## Architecture

```
Nova LP Agent
├── Hunter cycle (setiap 15 menit)
│   ├── Fetch dari Meteora Discovery API
│   ├── Enrich dengan Birdeye + Helius
│   ├── Compute Nova Score (0–100)
│   └── LLM (Claude) → DEPLOY atau SKIP
│
├── Healer cycle (setiap 5 menit)
│   ├── Get live position data dari DLMM SDK
│   ├── LLM (Claude) → STAY / CLOSE / REDEPLOY / CLAIM_FEES
│   └── Post-close: derive lesson → simpan ke DB
│
└── Telegram bot
    ├── /status /positions /stop /start /report /closeall
    └── Auto alerts: deploy, close, out-of-range, emergency
```

## Nova Score — composite risk scoring

```
Fee/TVL ratio (0–30 pts)  — paling penting, ukur yield efficiency
Volume 24h    (0–20 pts)  — likuiditas dan aktivitas
Organic score (0–20 pts)  — Meteora internal quality metric
TVL sweet spot (0–15 pts) — tidak terlalu besar, tidak terlalu kecil
Holder count  (0–10 pts)  — distribusi token
KOL/whale     (0–5 pts)   — sinyal strong hands

Penalties:
Wash trading   -50 pts   → langsung skip
Rugpull flag   -100 pts  → langsung skip
Bundle > 30%   -15 pts   → supply terkonsentrasi
Bundle > 50%   -35 pts   → bahaya
```

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
# Edit .env
```

### 2. Environment minimal

```bash
WALLET_PRIVATE_KEY=base58_key
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=bot_token
TELEGRAM_CHAT_ID=your_id
HELIUS_API_KEY=helius_key   # untuk whale tracking
BIRDEYE_API_KEY=birdeye_key # untuk holder count + mcap
```

### 3. Jalankan

```bash
# Dry run dulu (wajib) — tidak ada transaksi nyata
npm run dry

# Live
npm run dev
```

### 4. CLI tools

```bash
npm run screen     # manual scan pool sekarang
npm run stats      # lihat statistik performa
npm run positions  # lihat posisi terbuka
```

## Telegram Commands

| Command | Fungsi |
|---|---|
| `/status` | Status agent + performance |
| `/positions` | Daftar posisi terbuka |
| `/stop` | Pause agent |
| `/start` | Resume agent |
| `/report` | Daily report sekarang |
| `/closeall` | Close semua posisi + stop |

## Risk Management

```
Max posisi      : 5 (configurable)
Max per posisi  : 0.4 SOL (20% dari total capital)
Stop loss       : 15% per posisi
Take profit     : 25% per posisi
Max drawdown    : 30% total → emergency stop
Pool cooldown   : 4 jam setelah loss di pool tersebut
```

## Cara agent belajar

Setiap posisi yang ditutup:
1. LLM analisis performa (fees, APR, exit reason, kondisi entry)
2. Generate 1 konkret lesson: "Kalau [kondisi X] maka [aksi Y] karena [alasan Z]"
3. Lesson disimpan ke DB dengan confidence score
4. Lesson diinjeksikan ke Hunter/Healer prompt di cycle berikutnya
5. Semakin banyak posisi tertutup → agent semakin akurat

## Deploy ke VPS

```bash
# Build
npm run build

# Jalankan dengan PM2
npm install -g pm2
pm2 start dist/index.js --name nova-lp
pm2 save
pm2 startup

# Atau dengan screen
screen -S nova-lp
npm run dev
# Ctrl+A, D
```

---

## ⚠️ Disclaimer

Untuk tujuan edukasi. LP di DLMM berisiko — impermanent loss bisa melebihi fee yang didapat. Bukan financial advice.

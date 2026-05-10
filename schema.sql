-- ============================================================
-- KRONOS TERMINAL — SQLite Schema
-- Shared data layer for Scanner Bot, Dashboard, and Backtests
-- ============================================================

-- Polymarket events / markets
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  market      TEXT NOT NULL,
  yes_price   REAL,
  no_price    REAL,
  end_date    TEXT,
  resolved    INTEGER DEFAULT 0,
  outcome     TEXT,
  fetched_at  TEXT DEFAULT (datetime('now'))
);

-- Kronos edge signals (core table — written by Scanner Bot, read by Dashboard)
CREATE TABLE IF NOT EXISTS edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  market        TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  confidence    REAL NOT NULL,
  prob_up       REAL,
  prob_down     REAL,
  yes_price     REAL,
  ev            REAL,
  kelly         REAL,
  horizon_min   INTEGER,
  anchor_price  REAL,
  resolve_price REAL,
  resolved      INTEGER DEFAULT 0,
  correct       INTEGER,
  pnl           REAL,
  n_samples     INTEGER,
  inference_ms  INTEGER,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Backtest run summaries
CREATE TABLE IF NOT EXISTS backtest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at      TEXT DEFAULT (datetime('now')),
  market      TEXT NOT NULL,
  strategy    TEXT NOT NULL,
  bets        INTEGER,
  wins        INTEGER,
  losses      INTEGER,
  win_pct     REAL,
  avg_roi     REAL,
  cum_pnl     REAL,
  max_drawdown REAL,
  sharpe      REAL,
  params      TEXT
);

-- Equity snapshots for lifetime curves
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  market      TEXT NOT NULL,
  bankroll    REAL NOT NULL,
  pnl         REAL NOT NULL,
  open_bets   INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- LAG MONITOR — Spot vs Polymarket CLOB midpoint divergence
-- Inspired by Twitter "Gravia" scalper claim: edge comes from
-- the time gap between Binance spot moves and Polymarket repricing
-- ============================================================
CREATE TABLE IF NOT EXISTS lag_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  market          TEXT NOT NULL,         -- "BTC 5-Min Up/Down" itp.
  symbol          TEXT NOT NULL,         -- BTCUSDT / ETHUSDT
  interval_min    INTEGER NOT NULL,      -- 5 lub 15
  window_sec_in   INTEGER NOT NULL,      -- s. w aktualnym oknie (0..interval*60)
  spot_open       REAL NOT NULL,         -- cena na początku okna
  spot_now        REAL NOT NULL,         -- aktualna cena spot (Binance)
  spot_change_pct REAL NOT NULL,         -- (now-open)/open * 100
  poly_yes        REAL,                  -- YES midpoint z Polymarket CLOB
  fair_yes        REAL,                  -- przewidywana fair cena YES wg modelu lag
  lag_pct         REAL,                  -- fair_yes - poly_yes (>0 = poly za nisko = kup YES)
  abs_lag_pct     REAL,                  -- ABS(lag_pct)
  signal          TEXT                   -- 'BUY_YES' | 'BUY_NO' | 'NONE'
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_edges_ts_market ON edges(ts, market);
CREATE INDEX IF NOT EXISTS idx_edges_market_dir ON edges(market, direction);
CREATE INDEX IF NOT EXISTS idx_edges_resolved ON edges(resolved, market);
CREATE INDEX IF NOT EXISTS idx_events_market ON events(market);
CREATE INDEX IF NOT EXISTS idx_equity_ts_market ON equity_snapshots(ts, market);
CREATE INDEX IF NOT EXISTS idx_lag_ts_market    ON lag_log(ts, market);
CREATE INDEX IF NOT EXISTS idx_lag_abs           ON lag_log(abs_lag_pct);

/**
 * KRONOS SCANNER BOT — bot.ts
 *
 * The heartbeat of the terminal. Every 5 minutes:
 *   1. Fetches latest OHLCV candles from Bybit REST API
 *   2. Calls Python Kronos sidecar (POST /predict) for directional probability
 *   3. Computes EV and Kelly fraction
 *   4. Writes edge signal to SQLite
 *
 * Start: `pnpm run bot`
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import { getPolyPrice } from "./polymarket.js";
import { startBinanceFeed, isFeedHealthy } from "./binance-ws.js";
import { startLagMonitor, getLatestLagSignal } from "./lag-monitor.js";
import { execute, type EdgeSignal } from "../trader/trader.js";
import { runRedeemer } from "../trader/redeemer.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const CONFIG = {
  sidecarUrl: "http://localhost:8000/predict",
  healthUrl: "http://localhost:8000/health",
  bybitBase: "https://api.bybit.com",
  dbPath: resolve(import.meta.dirname, "..", "kronos.db"),
  scanIntervalMs: 5 * 60 * 1000,     // 5 minutes
  nSamples: 100,                       // Monte Carlo paths for live
  contextCandles: 50,                  // candles fed to model
  confGate: 0.55,                      // minimum confidence to record
  defaultYesPrice: 0.51,               // simulated Polymarket YES price
  // Filtr bet_price (2026-05-23): tylko trades z wysokim payout
  // Analiza 1467 trades: near-even (0.45-0.55) ma WR=47% vs BE=50% → -6% EV
  // Trades z bet_price<0.45 mają WR=53-57% vs BE=27-41% → ogromny edge
  maxBetPrice: 0.45,
  markets: [
    { name: "BTC 5-Min Up/Down",  symbol: "BTCUSDT", interval: "5",  horizonMin: 5,  skipHoursUtc: [], active: true  },
    { name: "ETH 5-Min Up/Down",  symbol: "ETHUSDT", interval: "5",  horizonMin: 5,  skipHoursUtc: [], active: true  },
    { name: "BTC 15-Min Up/Down", symbol: "BTCUSDT", interval: "15", horizonMin: 15, skipHoursUtc: [6, 7, 8, 10, 11, 15, 18], active: true  },
    // ETH 15M wyłączony (2026-05-23): rolling WR=36%, OOS=38.3% — poniżej break-even
    { name: "ETH 15-Min Up/Down", symbol: "ETHUSDT", interval: "15", horizonMin: 15, skipHoursUtc: [], active: false },
  ],
};

// ─── Session counters (reset on restart) ──────────────────────────────────

const SESSION = {
  cycles:     0,
  dcAgree:    0,   // Chronos + Lag zgodne
  dcConflict: 0,   // Chronos + Lag sprzeczne
  dcTotal:    0,   // łącznie sygnałów z Lag (nie NONE)
  startedAt:  new Date().toISOString().slice(0, 19),
};

// ─── Database ──────────────────────────────────────────────────────────────

const db = new Database(CONFIG.dbPath);
db.pragma("journal_mode = WAL");

// Migracja — dodaj kolumny DRY RUN jeśli nie istnieją (idempotentne)
for (const sql of [
  "ALTER TABLE edges ADD COLUMN traded        INTEGER DEFAULT 0",
  "ALTER TABLE edges ADD COLUMN trade_dry_run INTEGER",
  "ALTER TABLE edges ADD COLUMN trade_size_usd REAL",
  "ALTER TABLE edges ADD COLUMN trade_order_id TEXT",
]) {
  try { db.exec(sql); } catch { /* kolumna już istnieje */ }
}

const insertEdge = db.prepare(`
  INSERT INTO edges (
    ts, market, direction, confidence, prob_up, prob_down,
    yes_price, ev, kelly, horizon_min, anchor_price,
    n_samples, inference_ms
  ) VALUES (
    datetime('now'), ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?
  )
`);

const markTraded = db.prepare(`
  UPDATE edges SET
    traded         = 1,
    trade_dry_run  = ?,
    trade_size_usd = ?,
    trade_order_id = ?
  WHERE id = ?
`);

const resolveEdges = db.prepare(`
  UPDATE edges
  SET
    resolve_price = ?,
    resolved      = 1,
    correct       = CASE
                      WHEN direction = 'UP'   AND ? > anchor_price THEN 1
                      WHEN direction = 'DOWN' AND ? < anchor_price THEN 1
                      ELSE 0
                    END,
    pnl           = CASE
                      WHEN direction = 'UP'   AND ? > anchor_price THEN ev
                      WHEN direction = 'DOWN' AND ? < anchor_price THEN ev
                      ELSE -1.0
                    END
  WHERE market   = ?
    AND resolved = 0
    AND datetime(ts, '+' || horizon_min || ' minutes') <= datetime('now')
`);

// ─── Bybit OHLCV API ──────────────────────────────────────────────────────

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number = 100
): Promise<Candle[]> {
  const url = `${CONFIG.bybitBase}/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Bybit API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(`Bybit error: ${data.retMsg}`);
  }

  // Bybit returns newest first — reverse to chronological order
  return data.result.list
    .map((r: string[]) => ({
      timestamp: +r[0],
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
    .reverse();
}

// ─── Kronos Sidecar Call ───────────────────────────────────────────────────

interface SidecarResponse {
  direction: "UP" | "DOWN";
  prob_up: number;
  prob_down: number;
  confidence: number;
  n_samples: number;
  inference_ms: number;
  device: string;
  mode: string;
}

async function callSidecar(
  candles: number[][],
  nSamples: number = CONFIG.nSamples
): Promise<SidecarResponse> {
  const res = await fetch(CONFIG.sidecarUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candles,
      n_samples: nSamples,
      horizon: 1,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sidecar error ${res.status}: ${text}`);
  }

  return res.json() as Promise<SidecarResponse>;
}

// ─── Platt scaling recalibration ───────────────────────────────────────────
// Wygenerowane: python research/recalibrate_confidence.py (2026-05-12)
// Brier Score przed/po: BTC5M 0.4335→0.2499, ETH5M 0.4483→0.2482
//                       BTC15M 0.3680→0.2466, ETH15M 0.3856→0.2485
// Próbka v3: 424/438/160/166 resolved edges (10x więcej niż v1)
const PLATT: Record<string, [number, number]> = {
  "BTC 5-Min Up/Down":  [-0.1231,  0.0845],
  "ETH 5-Min Up/Down":  [-1.8713,  1.5900],
  "BTC 15-Min Up/Down": [ 0.7311, -0.4302],
  "ETH 15-Min Up/Down": [ 1.6770, -1.4257],
};

function recalibrate(rawConfidence: number, market: string): number {
  const [A, B] = PLATT[market] ?? [1, 0];
  const z = A * rawConfidence + B;
  return 1 / (1 + Math.exp(-z));  // sigmoid
}

// ─── EV & Kelly Computation ────────────────────────────────────────────────

function computeEV(confidence: number, yesPrice: number): number {
  return confidence * (1 / yesPrice) - 1;
}

function computeKelly(confidence: number, yesPrice: number): number {
  const payout = 1 / yesPrice;
  const b = payout - 1;
  const q = 1 - confidence;
  const f = (b * confidence - q) / b;
  return Math.max(0, Math.min(f, 1));
}

// ─── Window timing ─────────────────────────────────────────────────────────

/**
 * Ile sekund upłynęło od początku aktualnego okna rynkowego.
 * Okno 5-min → 300s, okno 15-min → 900s.
 */
function secondsIntoWindow(intervalMin: number): number {
  return (Date.now() % (intervalMin * 60 * 1000)) / 1000;
}

/**
 * Zwraca true jeśli jesteśmy w pierwszej połowie okna rynkowego.
 * 5-Min:  pierwsze 150s z 300s  (50%)
 * 15-Min: pierwsze 270s z 900s  (30%)
 */
function isValidEntry(intervalMin: number): boolean {
  const maxSec = intervalMin === 5 ? 150 : 270;
  return secondsIntoWindow(intervalMin) < maxSec;
}

// ─── Scan a single market ──────────────────────────────────────────────────

async function scanMarket(market: typeof CONFIG.markets[number]): Promise<void> {
  // Filtr godzinowy — pomiń dead zones UTC
  const utcHour = new Date().getUTCHours();
  if (market.skipHoursUtc.includes(utcHour)) {
    console.log(`  ⏭️  ${market.name.split(" ")[0]} ${market.horizonMin}M: skip (UTC ${utcHour}:xx — dead zone)`);
    return;
  }

  try {
    // 1. Fetch candles
    const candles = await fetchCandles(
      market.symbol,
      market.interval,
      CONFIG.contextCandles + 10 // fetch a few extra for safety
    );

    if (candles.length < CONFIG.contextCandles) {
      console.warn(`  ⚠️  ${market.name}: only ${candles.length} candles, need ${CONFIG.contextCandles}`);
      return;
    }

    // 2. Prepare context window (last N candles as [O,H,L,C,V])
    const window = candles
      .slice(-CONFIG.contextCandles)
      .map((c) => [c.open, c.high, c.low, c.close, c.volume]);

    const anchorPrice = candles[candles.length - 1].close;

    // 3. Call Kronos sidecar
    const pred = await callSidecar(window, CONFIG.nSamples);

    // 4. Pobierz cenę Polymarket — tylko jeśli jesteśmy w oknie wejścia
    const secIn    = Math.round(secondsIntoWindow(market.horizonMin));
    const inWindow = isValidEntry(market.horizonMin);

    const polyPrice = inWindow ? await getPolyPrice(market.name) : null;
    const yesPrice  = polyPrice?.yes ?? CONFIG.defaultYesPrice;

    let priceTag: string;
    if (polyPrice)    priceTag = `POLY:${yesPrice.toFixed(3)} [+${secIn}s]`;
    else if (inWindow) priceTag = `SIM:${CONFIG.defaultYesPrice} [+${secIn}s]`;
    else               priceTag = `SKIP [+${secIn}s — za późno na wejście]`;

    // Kupujemy YES gdy UP, NO gdy DOWN
    const betPrice = pred.direction === "UP" ? yesPrice : (1 - yesPrice);

    // Filtr bet_price — pomiń near-even trades (EV ujemny przy WR~47%)
    if (polyPrice && betPrice > CONFIG.maxBetPrice) {
      const symbol = market.symbol.replace("USDT", "");
      console.log(`  🚫 ${symbol} ${market.horizonMin}M: skip bet_price=${betPrice.toFixed(3)} > ${CONFIG.maxBetPrice} (near-even, brak edge)`);
      return;
    }

    // Rekalibracja Platt scaling — Chronos overconfident fix
    const rawConf = pred.confidence;
    const calConf = recalibrate(rawConf, market.name);

    const ev    = computeEV(calConf, betPrice);
    const kelly = computeKelly(calConf, betPrice);

    // 5. Double Confirmation — sprawdź czy Lag Monitor daje ten sam sygnał
    const lagSignal = getLatestLagSignal(market.name);
    const chronosUp = pred.direction === "UP";
    const lagBuyYes = lagSignal === "BUY_YES";
    const signalsAgree = (chronosUp && lagBuyYes) || (!chronosUp && lagSignal === "BUY_NO");
    // Aktualizuj session counters
    if (lagSignal !== "NONE") {
      SESSION.dcTotal++;
      if (signalsAgree) SESSION.dcAgree++;
      else              SESSION.dcConflict++;
    }

    // 6. Write to SQLite (RAW confidence — skalibrowane tylko dla EV/Kelly)
    const insertResult = insertEdge.run(
      market.name,
      pred.direction,
      rawConf,                 // ← RAW confidence (dla backtestów i rekalibracji)
      pred.prob_up,
      pred.prob_down,
      yesPrice,
      ev,
      kelly,
      market.horizonMin,
      anchorPrice,
      pred.n_samples,
      pred.inference_ms
    );
    const edgeId = Number(insertResult.lastInsertRowid);

    // 7. Log (pokaż raw → calibrated + double confirmation)
    const evPct    = (ev * 100).toFixed(1);
    const rawPct   = (rawConf * 100).toFixed(0);
    const calPct   = (calConf * 100).toFixed(0);
    const kellyPct = (kelly * 100).toFixed(1);
    const symbol   = market.symbol.replace("USDT", "");
    const modeTag  = pred.mode === "chronos" ? "🤖" : "📊";
    const winTag   = inWindow ? "✅" : "⏰";
    const agreeTag = signalsAgree ? " 🟢DC" : (lagSignal === "NONE" ? "" : " 🔴DC");

    console.log(
      `  ${winTag} ${modeTag} ${symbol} ${market.horizonMin}M → ` +
      `${pred.direction} ${rawPct}%→${calPct}% cal | ` +
      `EV ${evPct}% | K ${kellyPct}% | ` +
      `${pred.inference_ms}ms [${priceTag}]${agreeTag}`
    );

    // 8. Execute trade — tylko gdy jesteśmy w oknie wejścia i mamy prawdziwą cenę Poly
    if (inWindow && polyPrice && ev > 0) {
      const signal: EdgeSignal = {
        market:     market.name,
        direction:  pred.direction,
        confidence: calConf,
        yes_price:  yesPrice,
        ev,
        kelly,
        yesToken:   polyPrice.yesToken,
        noToken:    polyPrice.noToken,
      };
      execute(signal).then(result => {
        if (result.status === "dry-run" || result.status === "executed") {
          markTraded.run(
            result.status === "dry-run" ? 1 : 0,
            result.sizeUsd,
            result.orderId ?? null,
            edgeId
          );
        }
      }).catch((err: unknown) =>
        console.error(`  ❌ Trader: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ ${market.name}: ${msg}`);

    // Retry once after 2s
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const candles   = await fetchCandles(market.symbol, market.interval, CONFIG.contextCandles + 10);
      const window    = candles.slice(-CONFIG.contextCandles).map((c) => [c.open, c.high, c.low, c.close, c.volume]);
      const pred      = await callSidecar(window, CONFIG.nSamples);
      const polyPrice = await getPolyPrice(market.name);
      const yesPrice  = polyPrice?.yes ?? CONFIG.defaultYesPrice;
      const betPrice2 = pred.direction === "UP" ? yesPrice : (1 - yesPrice);
      const calConf2  = recalibrate(pred.confidence, market.name);
      const ev        = computeEV(calConf2, betPrice2);
      const kelly     = computeKelly(calConf2, betPrice2);
      insertEdge.run(
        market.name, pred.direction, pred.confidence, pred.prob_up, pred.prob_down,
        yesPrice, ev, kelly, market.horizonMin,
        candles[candles.length - 1].close, pred.n_samples, pred.inference_ms
      );
      console.log(`  🔄 ${market.name}: retry succeeded`);
    } catch {
      console.error(`  ❌ ${market.name}: retry also failed — skipping`);
    }
  }
}

// ─── Health Check ──────────────────────────────────────────────────────────

async function checkSidecar(): Promise<boolean> {
  try {
    const res = await fetch(CONFIG.healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = await res.json() as { status: string; model_ready: boolean; mode: string };
    console.log(`🔗 Sidecar: ${data.status} | mode: ${data.mode} | model_ready: ${data.model_ready}`);
    return true;
  } catch {
    return false;
  }
}

// ─── Main Loop ─────────────────────────────────────────────────────────────

async function resolveOldEdges(): Promise<void> {
  let totalResolved = 0;
  for (const market of CONFIG.markets) {
    try {
      const candles = await fetchCandles(market.symbol, market.interval, 2);
      const currentPrice = candles[candles.length - 1].close;
      const result = resolveEdges.run(
        currentPrice, currentPrice, currentPrice, currentPrice, currentPrice,
        market.name
      ) as { changes: number };
      if (result.changes > 0) {
        totalResolved += result.changes;
      }
    } catch { /* cicho — resolucja nie może blokować scanu */ }
  }
  if (totalResolved > 0) {
    console.log(`  ✅ Resolved ${totalResolved} edges`);
  }
}

let redeemerRunning = false;

async function runScanCycle(): Promise<void> {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`\n━━━ SCAN CYCLE ${ts} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Najpierw rozwiąż poprzednie predykcje
  await resolveOldEdges();

  for (const market of CONFIG.markets) {
    if (!market.active) {
      console.log(`  ⏸️  ${market.name.split(" ")[0]} ${market.horizonMin}M: paused`);
      continue;
    }
    await scanMarket(market);
  }

  // Summary
  SESSION.cycles++;
  const totalEdges = (
    db.prepare("SELECT COUNT(*) as count FROM edges").get() as { count: number }
  ).count;
  const dcWr = SESSION.dcTotal > 0
    ? ` | DC ${SESSION.dcAgree}✅ ${SESSION.dcConflict}❌ (${((SESSION.dcAgree / SESSION.dcTotal) * 100).toFixed(0)}% WR)`
    : "";
  console.log(`━━━ ${CONFIG.markets.length} markets | ${totalEdges} edges | cycle #${SESSION.cycles}${dcWr} ━━━`);

  // Auto-redeem co 6 cykli (30 min) — nie blokuje następnego scanu
  if (SESSION.cycles % 6 === 1 && !redeemerRunning) {
    redeemerRunning = true;
    runRedeemer()
      .catch(e => console.error("[REDEEMER]", e instanceof Error ? e.message : e))
      .finally(() => { redeemerRunning = false; });
  }
}

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════╗
║         KRONOS SCANNER BOT v1.0                  ║
║         Polymarket Research Terminal              ║
╚══════════════════════════════════════════════════╝
`);
  const dryRun = process.env.DRY_RUN !== "false";
  console.log(`📂 Database: ${CONFIG.dbPath}`);
  console.log(`🔗 Sidecar:  ${CONFIG.sidecarUrl}`);
  console.log(`📊 Markets:  ${CONFIG.markets.length}`);
  console.log(`⏱️  Interval: ${CONFIG.scanIntervalMs / 1000}s`);
  console.log(`🎯 Samples:  ${CONFIG.nSamples}`);
  console.log(`💰 Trader:   ${dryRun ? "🧪 DRY RUN (brak prawdziwych zleceń)" : "🔴 LIVE — prawdziwe USDC!"}\n`);

  // Wait for sidecar
  let sidecarReady = false;
  for (let attempt = 1; attempt <= 30; attempt++) {
    sidecarReady = await checkSidecar();
    if (sidecarReady) break;
    console.log(`⏳ Waiting for sidecar... (attempt ${attempt}/30)`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!sidecarReady) {
    console.error("❌ Sidecar not reachable after 30 attempts. Exiting.");
    process.exit(1);
  }

  // ── Uruchom Binance WS feed + lag monitor (równolegle) ───────────────
  startBinanceFeed();

  // Poczekaj max 10s aż WS się połączy i przyjmie pierwsze ticki
  for (let i = 0; i < 20; i++) {
    if (isFeedHealthy()) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (isFeedHealthy()) {
    console.log("✅ Binance WS healthy — starting lag monitor");
    startLagMonitor();
  } else {
    console.warn("⚠️  Binance WS not healthy after 10s — lag monitor NOT started (scan will work normally)");
  }

  // Synchronizuj z granicą 5-minutową zegara UTC
  // Polymarket otwiera okna dokładnie o :00, :05, :10, :15...
  const now          = Date.now();
  const interval5min = 5 * 60 * 1000;
  const msUntilNext  = interval5min - (now % interval5min);

  if (msUntilNext < 10_000) {
    // Jesteśmy < 10s od granicy — skanuj od razu
    await runScanCycle();
    setInterval(runScanCycle, CONFIG.scanIntervalMs);
  } else {
    // Poczekaj na następną granicę 5-minutową (z 2s zapasem przed granicą)
    const waitSec = Math.round(msUntilNext / 1000);
    console.log(`\n⏰ Synchronizacja z zegarem Polymarket...`);
    console.log(`   Następne okno za: ${waitSec}s — startujemy zsynchronizowani ✅`);
    await new Promise((r) => setTimeout(r, msUntilNext));
    await runScanCycle();
    setInterval(runScanCycle, CONFIG.scanIntervalMs);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

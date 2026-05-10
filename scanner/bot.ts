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
  markets: [
    { name: "BTC 5-Min Up/Down",  symbol: "BTCUSDT", interval: "5",  horizonMin: 5  },
    { name: "ETH 5-Min Up/Down",  symbol: "ETHUSDT", interval: "5",  horizonMin: 5  },
    { name: "BTC 15-Min Up/Down", symbol: "BTCUSDT", interval: "15", horizonMin: 15 },
    { name: "ETH 15-Min Up/Down", symbol: "ETHUSDT", interval: "15", horizonMin: 15 },
  ],
};

// ─── Database ──────────────────────────────────────────────────────────────

const db = new Database(CONFIG.dbPath);
db.pragma("journal_mode = WAL");

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
// Wygenerowane: python research/recalibrate_confidence.py (2026-05-10)
// Brier Score: 0.44 → 0.25 po Platt scaling (na 87-211 resolved edges/rynek)
const PLATT: Record<string, [number, number]> = {
  "BTC 5-Min Up/Down":  [1.0997, -1.1046],
  "ETH 5-Min Up/Down":  [-3.1659, 2.8221],
  "BTC 15-Min Up/Down": [-2.4435, 2.2109],
  "ETH 15-Min Up/Down": [-0.0433, -0.1152],
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
    const lagStatus = lagSignal === "NONE" ? "⏳" : (signalsAgree ? "✅" : "❌");

    // 6. Write to SQLite (RAW confidence — skalibrowane tylko dla EV/Kelly)
    insertEdge.run(
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

async function runScanCycle(): Promise<void> {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`\n━━━ SCAN CYCLE ${ts} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Najpierw rozwiąż poprzednie predykcje
  await resolveOldEdges();

  for (const market of CONFIG.markets) {
    await scanMarket(market);
  }

  // Summary
  const totalEdges = (
    db.prepare("SELECT COUNT(*) as count FROM edges").get() as { count: number }
  ).count;
  console.log(`━━━ ${CONFIG.markets.length} markets scanned | ${totalEdges} total edges in DB ━━━`);
}

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════╗
║         KRONOS SCANNER BOT v1.0                  ║
║         Polymarket Research Terminal              ║
╚══════════════════════════════════════════════════╝
`);
  console.log(`📂 Database: ${CONFIG.dbPath}`);
  console.log(`🔗 Sidecar:  ${CONFIG.sidecarUrl}`);
  console.log(`📊 Markets:  ${CONFIG.markets.length}`);
  console.log(`⏱️  Interval: ${CONFIG.scanIntervalMs / 1000}s`);
  console.log(`🎯 Samples:  ${CONFIG.nSamples}\n`);

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
    const waitSec = Math.round((msUntilNext - 2000) / 1000);
    console.log(`\n⏰ Synchronizacja z zegarem Polymarket...`);
    console.log(`   Następne okno za: ${waitSec}s — startujemy zsynchronizowani ✅`);
    await new Promise((r) => setTimeout(r, msUntilNext - 2000));
    await runScanCycle();
    setInterval(runScanCycle, CONFIG.scanIntervalMs);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

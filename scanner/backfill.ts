/**
 * KRONOS BACKFILL — backfill.ts
 *
 * Fetches historical candles from Bybit, runs Kronos inference on sliding
 * windows, and writes all predictions to SQLite for backtesting.
 *
 * Usage: `pnpm run backfill`
 *
 * This populates months of data in hours (depends on GPU speed).
 * Set N_SAMPLES to 25 for backfill (vs 100 for live) — 4x faster.
 */

import Database from "better-sqlite3";
import { resolve } from "path";

// ─── Configuration ─────────────────────────────────────────────────────────

const CONFIG = {
  sidecarUrl: "http://localhost:8000/predict",
  bybitBase: "https://api.bybit.com",
  dbPath: resolve(import.meta.dirname, "..", "kronos.db"),
  nSamples: 25,        // Lower for backfill speed (25 vs 100 live)
  contextCandles: 50,
  maxTrials: 200,      // Max predictions per market (override with --trials=N)
  defaultYesPrice: 0.51,
  markets: [
    { name: "BTC 5-Min Up/Down",  symbol: "BTCUSDT", interval: "5",  horizonMin: 5  },
    { name: "ETH 5-Min Up/Down",  symbol: "ETHUSDT", interval: "5",  horizonMin: 5  },
    { name: "BTC 15-Min Up/Down", symbol: "BTCUSDT", interval: "15", horizonMin: 15 },
    { name: "ETH 15-Min Up/Down", symbol: "ETHUSDT", interval: "15", horizonMin: 15 },
  ],
};

// Parse --trials=N from command line
const trialsArg = process.argv.find((a) => a.startsWith("--trials="));
const MAX_TRIALS = trialsArg ? parseInt(trialsArg.split("=")[1]) : CONFIG.maxTrials;

// ─── Database ──────────────────────────────────────────────────────────────

const db = new Database(CONFIG.dbPath);
db.pragma("journal_mode = WAL");

const insertEdge = db.prepare(`
  INSERT INTO edges (
    ts, market, direction, confidence, prob_up, prob_down,
    yes_price, ev, kelly, horizon_min, anchor_price,
    resolve_price, resolved, correct, n_samples, inference_ms
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
`);

// ─── Bybit API ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol: string, interval: string, limit: number = 1000) {
  const url = `${CONFIG.bybitBase}/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bybit ${res.status}`);
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg}`);

  return data.result.list
    .map((r: string[]) => ({
      timestamp: +r[0],
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
    }))
    .reverse(); // chronological order
}

// ─── Sidecar Call ──────────────────────────────────────────────────────────

async function callSidecar(candles: number[][]): Promise<{
  direction: "UP" | "DOWN";
  prob_up: number;
  prob_down: number;
  confidence: number;
  inference_ms: number;
}> {
  const res = await fetch(CONFIG.sidecarUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candles,
      n_samples: CONFIG.nSamples,
      horizon: 1,
    }),
  });
  if (!res.ok) throw new Error(`Sidecar ${res.status}`);
  return res.json();
}

// ─── Backfill a single market ──────────────────────────────────────────────

async function backfillMarket(market: typeof CONFIG.markets[number]): Promise<void> {
  console.log(`\n📊 Backfilling: ${market.name}`);
  console.log(`   Symbol: ${market.symbol} | Interval: ${market.interval}min`);

  // Fetch max historical candles
  const allCandles = await fetchCandles(market.symbol, market.interval, 1000);
  console.log(`   Fetched ${allCandles.length} candles from Bybit`);

  const ctx = CONFIG.contextCandles;
  const end = Math.min(allCandles.length - 1, ctx + MAX_TRIALS);
  const totalTrials = end - ctx;

  console.log(`   Running ${totalTrials} trials (context=${ctx}, stride=1)...`);

  let wins = 0;
  let total = 0;
  const startTime = Date.now();

  // Batch insert for performance
  const batchInsert = db.transaction(
    (
      rows: Array<{
        ts: string;
        direction: string;
        confidence: number;
        probUp: number;
        probDown: number;
        ev: number;
        kelly: number;
        anchor: number;
        resolve: number;
        correct: number;
        inferMs: number;
      }>
    ) => {
      for (const r of rows) {
        insertEdge.run(
          r.ts, market.name, r.direction, r.confidence, r.probUp, r.probDown,
          CONFIG.defaultYesPrice, r.ev, r.kelly, market.horizonMin, r.anchor,
          r.resolve, 1, r.correct ? 1 : 0, CONFIG.nSamples, r.inferMs
        );
      }
    }
  );

  const batch: Array<any> = [];
  const BATCH_SIZE = 10;

  for (let i = ctx; i < end; i++) {
    const window = allCandles
      .slice(i - ctx, i)
      .map((c: any) => [c.open, c.high, c.low, c.close, c.volume]);

    try {
      const pred = await callSidecar(window);

      const anchor = allCandles[i].close;
      const resolve = allCandles[i + 1].close;
      const actualUp = resolve > anchor;
      const correct = (pred.direction === "UP") === actualUp;
      if (correct) wins++;
      total++;

      const ev = pred.confidence * (1 / CONFIG.defaultYesPrice) - 1;
      const b = (1 / CONFIG.defaultYesPrice) - 1;
      const q = 1 - pred.confidence;
      const kelly = Math.max(0, Math.min((b * pred.confidence - q) / b, 1));

      // Use candle timestamp for historical accuracy
      const ts = new Date(allCandles[i].timestamp).toISOString().slice(0, 19);

      batch.push({
        ts,
        direction: pred.direction,
        confidence: pred.confidence,
        probUp: pred.prob_up,
        probDown: pred.prob_down,
        ev,
        kelly,
        anchor,
        resolve,
        correct,
        inferMs: pred.inference_ms,
      });

      // Flush batch
      if (batch.length >= BATCH_SIZE) {
        batchInsert(batch);
        batch.length = 0;
      }

      // Progress logging every 25 trials
      if (total % 25 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const acc = ((wins / total) * 100).toFixed(1);
        const eta = (((end - ctx - total) / total) * (Date.now() - startTime) / 1000).toFixed(0);
        console.log(
          `   [${total}/${totalTrials}] raw acc ${acc}% | ` +
          `${elapsed}s elapsed | ~${eta}s remaining`
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`   ⚠️  Trial ${total}: ${msg} — skipping`);
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    batchInsert(batch);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rawAcc = total > 0 ? ((wins / total) * 100).toFixed(1) : "N/A";
  console.log(
    `   ✅ ${market.name}: ${total} trials in ${elapsed}s | raw accuracy ${rawAcc}%`
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════╗
║         KRONOS BACKFILL v1.0                     ║
║         Historical Data Population               ║
╚══════════════════════════════════════════════════╝
`);
  console.log(`📂 Database: ${CONFIG.dbPath}`);
  console.log(`🎯 Trials:   ${MAX_TRIALS} per market`);
  console.log(`🎲 Samples:  ${CONFIG.nSamples} (backfill mode)`);
  console.log(`📊 Markets:  ${CONFIG.markets.length}\n`);

  // Check sidecar
  try {
    const health = await fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(5000) });
    const data = await health.json() as { mode: string };
    console.log(`🔗 Sidecar OK (mode: ${data.mode})\n`);
  } catch {
    console.error("❌ Sidecar not reachable at localhost:8000. Start it first:");
    console.error("   cd sidecar && uvicorn main:app --port 8000\n");
    process.exit(1);
  }

  const t0 = Date.now();
  for (const market of CONFIG.markets) {
    await backfillMarket(market);
  }

  const totalElapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);

  // Summary
  const stats = db
    .prepare(
      "SELECT market, COUNT(*) as count, ROUND(AVG(CASE WHEN correct=1 THEN 100.0 ELSE 0.0 END),1) as acc FROM edges WHERE resolved=1 GROUP BY market"
    )
    .all() as { market: string; count: number; acc: number }[];

  console.log(`\n═══ BACKFILL COMPLETE ═══════════════════════════`);
  console.log(`Total time: ${totalElapsed} min\n`);
  for (const s of stats) {
    console.log(`  ${s.market}: ${s.count} predictions | ${s.acc}% accuracy`);
  }
  console.log(`\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

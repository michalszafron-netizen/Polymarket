/**
 * KRONOS LAG MONITOR
 *
 * Co N sekund:
 *   1. Bierze spot snapshot z Binance WS (BTCUSDT, ETHUSDT)
 *   2. Pobiera midpoint Polymarket dla aktualnego okna 5/15-min
 *   3. Liczy "fair YES price" wg modelu wrażliwości na zmianę spot
 *   4. Loguje lukę (lag_pct) do tabeli lag_log
 *   5. Emituje sygnał BUY_YES / BUY_NO gdy luka > THRESHOLD
 *
 * MODEL FAIR PRICE (skalibrowany na 109k próbkach z 38h danych):
 *   fair_yes = clamp(α + spot_change_pct * SENSITIVITY, 0.02, 0.98)
 *
 *   Kalibracja (regresja liniowa poly_yes ~ spot_change_pct, R² > 0.82):
 *     - BTC 5M:  α=0.495, SENS=444  (każde +0.01% spot → +4.44pp fair)
 *     - ETH 5M:  α=0.504, SENS=383
 *     - BTC 15M: α=0.504, SENS=251
 *     - ETH 15M: α=0.511, SENS=202
 *
 * EDGE DETECTION (po kalibracji):
 *   |fair_yes - poly_yes| > 13pp  (95. percentyl |lag|)
 *   + filtr okna: tylko pierwsza połowa (5M <150s, 15M <270s)
 *
 * Kalibracja: python research/calibrate_lag.py
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import { getSpotSnapshot, isFeedHealthy, type Symbol } from "./binance-ws.js";
import { getPolyPrice } from "./polymarket.js";

// ─── Config ────────────────────────────────────────────────────────────────

const CFG = {
  dbPath:        resolve(import.meta.dirname, "..", "kronos.db"),
  pollIntervalMs: 5_000,             // co 5s próbka
  thresholdPct:  17.4,               // |lag| > 17.4pp → sygnał (95. percentyl |lag| po kalibracji v2)
  // Wykalibrowane na ~20k próbkach (2026-05-10) — python research/calibrate_lag.py
  // R²: 0.675-0.796, sensitivity wzrosła ~30% vs v1
  markets: [
    { name: "BTC 5-Min Up/Down",  symbol: "BTCUSDT" as Symbol, intervalMin: 5  as 5 | 15, sensitivity: 598, alpha: 0.496, windowMax: 150 },
    { name: "ETH 5-Min Up/Down",  symbol: "ETHUSDT" as Symbol, intervalMin: 5  as 5 | 15, sensitivity: 553, alpha: 0.497, windowMax: 150 },
    { name: "BTC 15-Min Up/Down", symbol: "BTCUSDT" as Symbol, intervalMin: 15 as 5 | 15, sensitivity: 331, alpha: 0.505, windowMax: 270 },
    { name: "ETH 15-Min Up/Down", symbol: "ETHUSDT" as Symbol, intervalMin: 15 as 5 | 15, sensitivity: 286, alpha: 0.503, windowMax: 270 },
  ],
};

// ─── DB prepared ───────────────────────────────────────────────────────────

const db = new Database(CFG.dbPath);
db.pragma("journal_mode = WAL");

const insertLag = db.prepare(`
  INSERT INTO lag_log (
    ts, market, symbol, interval_min, window_sec_in,
    spot_open, spot_now, spot_change_pct,
    poly_yes, fair_yes, lag_pct, abs_lag_pct, signal
  ) VALUES (
    datetime('now'), ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?
  )
`);

// ─── Fair price model (skalibrowany) ───────────────────────────────────────

function fairYesPrice(spotChangePct: number, sensitivity: number, alpha: number): number {
  // α + zmiana procentowa * wrażliwość / 100, clampowana
  // α to bazowe poly_yes przy spot_change=0 (z kalibracji, różni się od 0.5!)
  const raw = alpha + (spotChangePct / 100) * sensitivity;
  return Math.max(0.02, Math.min(0.98, raw));
}

function classifySignal(lagPct: number, windowSecIn: number, windowMax: number): "BUY_YES" | "BUY_NO" | "NONE" {
  // Filtr okna: ignoruj sygnały z drugiej połowy okna (cena "zatruta")
  if (windowSecIn >= windowMax) return "NONE";
  if (lagPct >  CFG.thresholdPct) return "BUY_YES";   // poly za nisko, fair wyższe
  if (lagPct < -CFG.thresholdPct) return "BUY_NO";    // poly za wysoko, fair niższe
  return "NONE";
}

// ─── Main poll cycle ───────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  if (!isFeedHealthy()) return;

  // Pobierz wszystkie midpointy Polymarket równolegle
  const polyPromises = CFG.markets.map(async m => {
    const p = await getPolyPrice(m.name);
    return { name: m.name, polyYes: p?.yes ?? null };
  });
  const polyResults = await Promise.all(polyPromises);
  const polyMap = new Map(polyResults.map(r => [r.name, r.polyYes]));

  for (const m of CFG.markets) {
    const snap = getSpotSnapshot(m.symbol, m.intervalMin);
    if (!snap) continue;

    const polyYes = polyMap.get(m.name) ?? null;
    const fairYes = fairYesPrice(snap.changePct, m.sensitivity, m.alpha);

    // Bez Polymarket — i tak loguj snapshot spot (przyda się do analiz)
    let lagPct  : number | null = null;
    let absLag  : number | null = null;
    let signal  : "BUY_YES" | "BUY_NO" | "NONE" = "NONE";

    if (polyYes !== null) {
      lagPct = (fairYes - polyYes) * 100;       // w punktach procentowych
      absLag = Math.abs(lagPct);
      signal = classifySignal(lagPct, snap.windowSecIn, m.windowMax);
    }

    insertLag.run(
      m.name, m.symbol, m.intervalMin, snap.windowSecIn,
      snap.openOfWindow, snap.price, snap.changePct,
      polyYes, fairYes, lagPct, absLag, signal
    );

    // Zapisz ostatni sygnał dla Double Confirmation
    latestSignals.set(m.name, { signal, ts: Date.now() });

    // Loguj do konsoli tylko gdy mamy poly, jesteśmy w oknie, i jest sygnał
    if (polyYes !== null && snap.windowSecIn < m.windowMax && signal !== "NONE") {
      const arrow = signal === "BUY_YES" ? "🟢" : "🔴";
      const sign  = (lagPct ?? 0) >= 0 ? "+" : "";
      console.log(
        `  ${arrow} LAG ${m.name.split(" ")[0]} ${m.intervalMin}M: ` +
        `spot ${snap.changePct >= 0 ? "+" : ""}${snap.changePct.toFixed(3)}% | ` +
        `poly ${polyYes.toFixed(3)} vs fair ${fairYes.toFixed(3)} | ` +
        `lag ${sign}${(lagPct ?? 0).toFixed(2)}pp [${signal}] [+${snap.windowSecIn}s]`
      );
    }
  }
}

// ─── Double Confirmation — przechowuje ostatni sygnał per market ──────────

const latestSignals = new Map<string, { signal: "BUY_YES" | "BUY_NO" | "NONE"; ts: number }>();

/**
 * Zwraca ostatni sygnał Lag Monitora dla danego rynku (ważny przez 30s).
 * Używane przez bot.ts do strategii "Double Confirmation".
 */
export function getLatestLagSignal(market: string): "BUY_YES" | "BUY_NO" | "NONE" {
  const entry = latestSignals.get(market);
  if (!entry) return "NONE";
  // Sygnał ważny tylko przez 30s (odświeżany co 5s, więc max 6 próbek)
  if (Date.now() - entry.ts > 30_000) return "NONE";
  return entry.signal;
}

// ─── Public ────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

export function startLagMonitor(): void {
  if (timer) return;
  console.log(`📊 Lag monitor: poll every ${CFG.pollIntervalMs/1000}s, threshold |${CFG.thresholdPct}pp|`);
  // Pierwsze poll po 5s żeby WS się ustabilizował
  setTimeout(() => {
    pollOnce().catch(e => console.error("lag poll err:", e));
    timer = setInterval(() => {
      pollOnce().catch(e => console.error("lag poll err:", e));
    }, CFG.pollIntervalMs);
  }, 5000);
}

export function stopLagMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * KRONOS — Binance WebSocket spot price feed.
 *
 * Łączy się ze streamem kline_1s i utrzymuje aktualną cenę spot dla
 * BTC/USDT i ETH/USDT w pamięci. Daje sub-sekundową aktualizację —
 * krytyczne dla detekcji lukI Polymarket vs spot.
 *
 * Strategia (re-engineering "Gravia scalper"):
 *   spot_change_pct = (now - openOfCurrentWindow) / openOfCurrentWindow
 *   fair_yes        = 0.5 + spot_change_pct * SENSITIVITY
 *   lag             = fair_yes - poly_midpoint
 *   |lag| > 0.03   → potencjalny edge
 */

import WebSocket from "ws";

const STREAM_URL = "wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1s/ethusdt@kline_1s";

export type Symbol = "BTCUSDT" | "ETHUSDT";

interface PriceState {
  symbol:        Symbol;
  lastPrice:     number;
  lastUpdateMs:  number;
  // Open price na początku każdego okna (5-min i 15-min)
  windowOpens:   { 5: { ts: number; open: number }; 15: { ts: number; open: number } };
}

const state: Record<Symbol, PriceState> = {
  BTCUSDT: { symbol: "BTCUSDT", lastPrice: 0, lastUpdateMs: 0, windowOpens: { 5: { ts: 0, open: 0 }, 15: { ts: 0, open: 0 } } },
  ETHUSDT: { symbol: "ETHUSDT", lastPrice: 0, lastUpdateMs: 0, windowOpens: { 5: { ts: 0, open: 0 }, 15: { ts: 0, open: 0 } } },
};

let ws: WebSocket | null = null;
let connected = false;
let reconnectAttempts = 0;

// ─── Window helpers ────────────────────────────────────────────────────────

function windowOpenTs(intervalMin: 5 | 15): number {
  const ms = intervalMin * 60 * 1000;
  return Math.floor(Date.now() / ms) * ms;
}

function updateWindowOpen(sym: Symbol, intervalMin: 5 | 15, price: number) {
  const slot = windowOpenTs(intervalMin);
  const w    = state[sym].windowOpens[intervalMin];
  if (w.ts !== slot) {
    // nowe okno — zapisz aktualną cenę jako open
    w.ts   = slot;
    w.open = price;
  }
}

// ─── Connection ────────────────────────────────────────────────────────────

function connect() {
  if (ws) return;
  ws = new WebSocket(STREAM_URL);

  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    console.log("📡 Binance WS: connected (BTCUSDT, ETHUSDT @ 1s)");
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      const k   = msg?.data?.k;
      if (!k) return;

      const symbol: Symbol = (k.s || "").toUpperCase();
      if (symbol !== "BTCUSDT" && symbol !== "ETHUSDT") return;

      const price = parseFloat(k.c);
      if (!price || isNaN(price)) return;

      state[symbol].lastPrice    = price;
      state[symbol].lastUpdateMs = Date.now();

      updateWindowOpen(symbol, 5,  price);
      updateWindowOpen(symbol, 15, price);
    } catch { /* ignore parse errors */ }
  });

  ws.on("close", () => {
    connected = false;
    ws = null;
    reconnectAttempts++;
    const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempts);
    console.warn(`⚠️  Binance WS: closed — reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  });

  ws.on("error", (err: Error) => {
    console.error(`⚠️  Binance WS error: ${err.message}`);
    // 'close' will be emitted next, which handles reconnect
  });
}

// ─── Public API ────────────────────────────────────────────────────────────

export function startBinanceFeed(): void {
  connect();
}

export interface SpotSnapshot {
  symbol:          Symbol;
  price:           number;
  openOfWindow:    number;          // open ceny w aktualnym oknie 5/15 min
  changePct:       number;          // (price - open) / open * 100
  windowSecIn:     number;          // sekundy od początku okna
  ageMs:           number;          // jak stara jest cena (ms od ostatniego ticka)
}

export function getSpotSnapshot(symbol: Symbol, intervalMin: 5 | 15): SpotSnapshot | null {
  const s = state[symbol];
  if (!s.lastPrice) return null;

  const w = s.windowOpens[intervalMin];
  if (!w.open) return null;

  const ageMs       = Date.now() - s.lastUpdateMs;
  const windowSecIn = Math.floor((Date.now() - w.ts) / 1000);
  const changePct   = ((s.lastPrice - w.open) / w.open) * 100;

  return {
    symbol,
    price:        s.lastPrice,
    openOfWindow: w.open,
    changePct,
    windowSecIn,
    ageMs,
  };
}

export function isFeedHealthy(): boolean {
  if (!connected) return false;
  // Both symbols must have a tick within last 10s
  return ["BTCUSDT", "ETHUSDT"].every(
    sym => Date.now() - state[sym as Symbol].lastUpdateMs < 10_000
  );
}

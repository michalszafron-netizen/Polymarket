import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Zwraca dane Spot vs Polymarket lag dla dashboard.
 *
 * Query params:
 *   ?market=BTC%205-Min%20Up%2FDown    (opcjonalnie — domyślnie BTC 5M)
 *   ?limit=120                          (ostatnie N próbek)
 */

interface LagRow {
  ts: string;
  market: string;
  symbol: string;
  interval_min: number;
  window_sec_in: number;
  spot_open: number;
  spot_now: number;
  spot_change_pct: number;
  poly_yes: number | null;
  fair_yes: number | null;
  lag_pct: number | null;
  abs_lag_pct: number | null;
  signal: string;
}

export async function GET(req: Request) {
  try {
    const url    = new URL(req.url);
    const market = url.searchParams.get("market") ?? "BTC 5-Min Up/Down";
    const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? "120", 10) || 120, 500);

    const db = getDb();

    // Najnowsza próbka per market
    const latestPerMarket = db.prepare(
      `SELECT * FROM lag_log
       WHERE id IN (
         SELECT MAX(id) FROM lag_log GROUP BY market
       )`
    ).all() as LagRow[];

    // Historia dla wybranego rynku
    const series = db.prepare(
      `SELECT ts, spot_change_pct, poly_yes, fair_yes, lag_pct, signal, window_sec_in
       FROM lag_log
       WHERE market = ?
       ORDER BY id DESC
       LIMIT ?`
    ).all(market, limit) as LagRow[];

    // Ostatnie sygnały (BUY_YES / BUY_NO) — ostatnie 24h
    const recentSignals = db.prepare(
      `SELECT ts, market, signal, lag_pct, spot_change_pct, poly_yes, fair_yes, window_sec_in
       FROM lag_log
       WHERE signal IN ('BUY_YES','BUY_NO')
         AND ts >= datetime('now','-24 hours')
       ORDER BY id DESC
       LIMIT 50`
    ).all() as LagRow[];

    // Statystyki: ile sygnałów / max lag / średni abs lag (24h)
    const stats24h = db.prepare(
      `SELECT
         COUNT(*) AS samples,
         SUM(CASE WHEN signal != 'NONE' THEN 1 ELSE 0 END) AS edges,
         ROUND(AVG(abs_lag_pct), 3) AS avg_abs_lag,
         ROUND(MAX(abs_lag_pct), 3) AS max_abs_lag
       FROM lag_log
       WHERE ts >= datetime('now','-24 hours')
         AND poly_yes IS NOT NULL`
    ).get() as { samples: number; edges: number; avg_abs_lag: number | null; max_abs_lag: number | null };

    return NextResponse.json({
      latestPerMarket,
      series:        series.reverse(),  // chronologically: oldest → newest
      recentSignals,
      stats24h,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

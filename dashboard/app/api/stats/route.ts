import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();

    // Total edges
    const totalEdges = (
      db.prepare("SELECT COUNT(*) as count FROM edges").get() as { count: number }
    ).count;

    // Resolved edges
    const resolvedEdges = (
      db
        .prepare("SELECT COUNT(*) as count FROM edges WHERE resolved = 1")
        .get() as { count: number }
    ).count;

    // Win rate
    const winRate =
      resolvedEdges > 0
        ? (
            db
              .prepare(
                "SELECT ROUND(AVG(CASE WHEN correct=1 THEN 100.0 ELSE 0.0 END), 1) as rate FROM edges WHERE resolved=1"
              )
              .get() as { rate: number }
          ).rate
        : null;

    // Per-market stats
    const marketStats = db
      .prepare(
        `SELECT 
          market,
          COUNT(*) as total,
          SUM(CASE WHEN resolved=1 THEN 1 ELSE 0 END) as resolved,
          ROUND(AVG(CASE WHEN resolved=1 AND correct=1 THEN 100.0 WHEN resolved=1 THEN 0.0 END), 1) as accuracy,
          ROUND(AVG(confidence), 3) as avg_conf,
          ROUND(AVG(ev), 4) as avg_ev
        FROM edges
        GROUP BY market
        ORDER BY market`
      )
      .all();

    // Latest edge per market
    const latestEdges = db
      .prepare(
        `SELECT e.* FROM edges e
        INNER JOIN (
          SELECT market, MAX(ts) as max_ts FROM edges GROUP BY market
        ) latest ON e.market = latest.market AND e.ts = latest.max_ts`
      )
      .all();

    // Backtest runs
    const backtestRuns = db
      .prepare(
        "SELECT * FROM backtest_runs ORDER BY run_at DESC LIMIT 10"
      )
      .all();

    return NextResponse.json({
      totalEdges,
      resolvedEdges,
      winRate,
      marketStats,
      latestEdges,
      backtestRuns,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

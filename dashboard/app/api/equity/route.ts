import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface EdgeRow {
  ts: string;
  direction: string;
  confidence: number;
  ev: number;
  kelly: number;
  correct: number | null;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const market = searchParams.get("market") ?? "BTC 5-Min Up/Down";
    const payout = Number(searchParams.get("payout") ?? 1.96);
    const maxKelly = Number(searchParams.get("maxKelly") ?? 0.25);
    const gate = Number(searchParams.get("gate") ?? 0.55);
    const bankroll = Number(searchParams.get("bankroll") ?? 10000);

    const db = getDb();

    const edges = db
      .prepare(
        `SELECT ts, direction, confidence, ev, kelly, correct
         FROM edges WHERE market = ? AND resolved = 1
         ORDER BY ts ASC`
      )
      .all(market) as EdgeRow[];

    let bal = bankroll;
    let peak = bankroll;
    let maxDd = 0;
    let wins = 0;
    let losses = 0;

    const curve = edges
      .filter((e) => e.confidence >= gate && e.ev > 0)
      .map((e) => {
        const f = Math.min(e.kelly ?? 0, maxKelly);
        const stake = bal * f;
        const win = e.correct === 1;

        if (win) {
          bal += stake * (payout - 1);
          wins++;
        } else {
          bal -= stake;
          losses++;
        }

        if (bal > peak) peak = bal;
        const dd = peak > 0 ? (peak - bal) / peak : 0;
        if (dd > maxDd) maxDd = dd;

        return { ts: e.ts, pnl: Math.round(bal - bankroll), bankroll: Math.round(bal) };
      });

    return NextResponse.json({
      curve,
      summary: {
        bets: wins + losses,
        wins,
        losses,
        winPct: wins + losses > 0 ? wins / (wins + losses) : 0,
        finalPnl: curve[curve.length - 1]?.pnl ?? 0,
        maxDrawdown: maxDd,
        finalBankroll: Math.round(bal),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

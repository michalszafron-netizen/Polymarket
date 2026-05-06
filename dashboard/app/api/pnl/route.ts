import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MARKETS = [
  "BTC 5-Min Up/Down",
  "ETH 5-Min Up/Down",
  "BTC 15-Min Up/Down",
  "ETH 15-Min Up/Down",
];

const BUDGET = 100;
const BET    = 1;

interface EdgeRow {
  direction:  string;
  yes_price:  number;
  correct:    number;
  ts:         string;
}

function simulate(db: ReturnType<typeof import("@/lib/db").getDb>, market: string | null) {
  const q = market
    ? `SELECT direction, yes_price, correct, ts FROM edges
       WHERE resolved=1 AND ABS(yes_price-0.51)>0.005
         AND yes_price BETWEEN 0.10 AND 0.90
         AND market=?
       ORDER BY ts ASC`
    : `SELECT direction, yes_price, correct, ts FROM edges
       WHERE resolved=1 AND ABS(yes_price-0.51)>0.005
         AND yes_price BETWEEN 0.10 AND 0.90
       ORDER BY ts ASC`;

  const rows = (market ? db.prepare(q).all(market) : db.prepare(q).all()) as EdgeRow[];

  let bankroll = BUDGET;
  let wins = 0, losses = 0;

  const curve: { t: number; bk: number; ts: string }[] = [
    { t: 0, bk: BUDGET, ts: rows[0]?.ts?.slice(11, 16) ?? "start" }
  ];

  rows.forEach((r, i) => {
    if (bankroll <= 0) return;
    const bet      = Math.min(BET, bankroll);
    const betPrice = r.direction === "UP" ? r.yes_price : (1 - r.yes_price);
    const safe     = Math.max(0.01, Math.min(0.99, betPrice));
    const payout   = 1 / safe;

    if (r.correct === 1) { bankroll += bet * (payout - 1); wins++;   }
    else                  { bankroll -= bet;                 losses++; }

    curve.push({ t: i + 1, bk: Math.round(bankroll * 100) / 100, ts: r.ts.slice(11, 16) });
  });

  const total = wins + losses;
  return {
    curve,
    stats: {
      trades:  total,
      wins,
      losses,
      winRate: total > 0 ? Math.round(wins / total * 1000) / 10 : 0,
      pnl:     Math.round((bankroll - BUDGET) * 100) / 100,
      roi:     Math.round((bankroll - BUDGET) / BUDGET * 1000) / 10,
      bankroll: Math.round(bankroll * 100) / 100,
    },
  };
}

export async function GET() {
  try {
    const db     = getDb();
    const result: Record<string, ReturnType<typeof simulate>> = {};

    for (const mkt of MARKETS) result[mkt] = simulate(db, mkt);
    result["ALL"] = simulate(db, null);

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

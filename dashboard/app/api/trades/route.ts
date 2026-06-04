import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface TradeRow {
  id:             number;
  ts:             string;
  market:         string;
  direction:      string;
  yes_price:      number;
  ev:             number;
  confidence:     number;
  horizon_min:    number;
  anchor_price:   number;
  resolve_price:  number | null;
  resolved:       number;
  correct:        number | null;
  trade_dry_run:  number;
  trade_size_usd: number;
  trade_order_id: string | null;
}

export async function GET() {
  try {
    const db = getDb();

    const rows = db.prepare(`
      SELECT
        id, ts, market, direction, yes_price, ev, confidence,
        horizon_min, anchor_price, resolve_price,
        resolved, correct,
        trade_dry_run, trade_size_usd, trade_order_id
      FROM edges
      WHERE traded = 1
      ORDER BY ts DESC
      LIMIT 200
    `).all() as TradeRow[];

    // Podziel na DRY RUN i LIVE
    const dryRun = rows.filter(r => r.trade_dry_run === 1);
    const live   = rows.filter(r => r.trade_dry_run === 0);

    function buildStats(trades: TradeRow[]) {
      const resolved = trades.filter(t => t.resolved === 1);
      const wins     = resolved.filter(t => t.correct === 1);
      const losses   = resolved.filter(t => t.correct === 0);
      const open     = trades.filter(t => t.resolved === 0);

      // Equity curve — tylko resolved, chronologicznie
      const chronological = [...resolved].sort((a, b) => a.ts.localeCompare(b.ts));
      let cumPnl = 0;
      const curve = chronological.map(t => {
        const betPrice = t.direction === "UP" ? t.yes_price : (1 - t.yes_price);
        const pnl = t.correct === 1
          ? (1 / betPrice - 1) * t.trade_size_usd
          : -t.trade_size_usd;
        cumPnl += pnl;
        return { ts: t.ts.slice(5, 16), cumPnl: +cumPnl.toFixed(2) };
      });

      // Per-market breakdown
      const markets: Record<string, { trades: number; wins: number; losses: number }> = {};
      for (const t of resolved) {
        if (!markets[t.market]) markets[t.market] = { trades: 0, wins: 0, losses: 0 };
        markets[t.market].trades++;
        if (t.correct === 1) markets[t.market].wins++;
        else markets[t.market].losses++;
      }

      return {
        total:    trades.length,
        wins:     wins.length,
        losses:   losses.length,
        open:     open.length,
        winRate:  resolved.length > 0 ? +(wins.length / resolved.length * 100).toFixed(1) : null,
        totalPnl: +cumPnl.toFixed(2),
        avgEv:    trades.length > 0
          ? +(trades.reduce((s, t) => s + t.ev, 0) / trades.length * 100).toFixed(1)
          : null,
        markets,
        curve,
      };
    }

    // Pełna lista dla tabeli (ostatnie 100)
    const tradesForTable = rows.slice(0, 100).map(t => ({
      id:            t.id,
      ts:            t.ts,
      market:        t.market,
      direction:     t.direction,
      side:          t.direction === "UP" ? "YES" : "NO",
      yes_price:     t.yes_price,
      bet_price:     t.direction === "UP" ? t.yes_price : +(1 - t.yes_price).toFixed(4),
      ev:            t.ev,
      confidence:    t.confidence,
      size_usd:      t.trade_size_usd,
      dry_run:       t.trade_dry_run === 1,
      order_id:      t.trade_order_id,
      resolved:      t.resolved === 1,
      correct:       t.correct,
      pnl:           t.correct === null ? null : (
        t.correct === 1
          ? +((1 / (t.direction === "UP" ? t.yes_price : 1 - t.yes_price) - 1) * t.trade_size_usd).toFixed(2)
          : +-t.trade_size_usd.toFixed(2)
      ),
    }));

    return NextResponse.json({
      trades:    tradesForTable,
      dryStats:  buildStats(dryRun),
      liveStats: buildStats(live),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

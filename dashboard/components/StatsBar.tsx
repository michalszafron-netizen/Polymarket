"use client";

interface StatsData {
  totalEdges: number;
  resolvedEdges: number;
  winRate: number | null;
  marketStats: Array<{
    market: string;
    total: number;
    resolved: number;
    accuracy: number | null;
    avg_conf: number;
    avg_ev: number;
  }>;
}

interface PnlStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  roi: number;
  bankroll: number;
}

export function StatsBar({ stats, pnlAll }: {
  stats: StatsData | null;
  pnlAll?: PnlStats | null;
}) {
  const resolved  = stats?.resolvedEdges ?? 0;
  const pnl       = pnlAll?.pnl ?? 0;
  const winRate   = pnlAll?.winRate ?? stats?.winRate ?? null;
  const roi       = pnlAll?.roi ?? 0;
  const trades    = pnlAll?.trades ?? 0;

  const pnlColor  = pnl >= 0 ? "var(--green)" : "var(--hot)";
  const hitColor  = (winRate ?? 0) >= 50 ? "var(--green)" : "var(--hot)";

  return (
    <>
      {/* PNL */}
      <div className="bx stat">
        <span className="c-bl" /><span className="c-br" />
        <div className="lbl mono upper">PNL</div>
        <div className="val" style={{ color: pnlColor }}>
          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
        </div>
        <div className="sub mono">
          ROI {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
        </div>
      </div>

      {/* HIT */}
      <div className="bx stat">
        <span className="c-bl" /><span className="c-br" />
        <div className="lbl mono upper">HIT</div>
        <div className="val" style={{ color: hitColor }}>
          {winRate ? `${winRate.toFixed(1)}%` : "--%"}
          <span className="unit">/ {trades} POLY</span>
        </div>
        <div className="sub mono">LIVE TRADES</div>
      </div>

      {/* EDGE — avg payout */}
      <div className="bx stat">
        <span className="c-bl" /><span className="c-br" />
        <div className="lbl mono upper">EDGE</div>
        <div className="val" style={{ color: "var(--green)" }}>
          {pnlAll && pnlAll.trades > 0
            ? `+${((pnlAll.pnl / pnlAll.trades) * 100).toFixed(1)}%`
            : "+0%"}
        </div>
        <div className="sub mono">AVG / TRADE</div>
      </div>

      {/* SCAN RATE */}
      <div className="bx stat">
        <span className="c-bl" /><span className="c-br" />
        <div className="lbl mono upper">RESOLVED</div>
        <div className="val">{resolved.toLocaleString()}</div>
        <div className="sub mono">TOTAL EDGES</div>
      </div>

      {/* SCAN */}
      <div className="bx stat">
        <span className="c-bl" /><span className="c-br" />
        <div className="lbl mono upper">SCAN</div>
        <div className="val">
          {stats?.marketStats?.length ? `${stats.marketStats.length * 60}/HR` : "0/HR"}
        </div>
        <div className="sub mono">RATE</div>
      </div>
    </>
  );
}

"use client";

interface StatsData {
  marketStats: Array<{
    market: string;
    total: number;
    resolved: number;
    accuracy: number | null;
    avg_conf: number;
    avg_ev: number;
  }>;
}

export function MarketYield({ stats }: { stats: StatsData | null }) {
  const markets = stats?.marketStats ?? [];

  return (
    <div className="bx">
      <div className="panel-head">
        <div className="panel-title mono upper">Market Yield</div>
      </div>

      {markets.length === 0 ? (
        <div className="empty-row">
          // no market data yet //
        </div>
      ) : (
        markets.map((m) => {
          const acc = m.accuracy ?? 0;
          const symbol = m.market.split(" ")[0];
          const timeframe = m.market.includes("5-Min") ? "5M" : "10M";
          const barWidth = Math.min(Math.max(acc, 0), 100);

          return (
            <div className="yield-row" key={m.market}>
              <div className="name">
                {symbol} {timeframe}
              </div>
              <div className="ybar">
                <div style={{ width: `${barWidth}%` }} />
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  textAlign: "right",
                  color:
                    acc >= 55
                      ? "var(--green)"
                      : acc >= 50
                      ? "var(--yellow)"
                      : "var(--hot)",
                }}
              >
                {acc.toFixed(1)}%
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: "var(--ink-3)",
                  textAlign: "right",
                }}
              >
                {m.total} sig
              </div>
            </div>
          );
        })
      )}

      {/* Average EV */}
      {markets.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="mini-grid">
            <div className="mini">
              <div className="l">AVG EV</div>
              <div
                className={`v ${
                  markets.reduce((s, m) => s + (m.avg_ev ?? 0), 0) /
                    markets.length >
                  0
                    ? "green"
                    : "hot"
                }`}
              >
                {(
                  (markets.reduce((s, m) => s + (m.avg_ev ?? 0), 0) /
                    markets.length) *
                  100
                ).toFixed(1)}
                %
              </div>
            </div>
            <div className="mini">
              <div className="l">AVG CONF</div>
              <div className="v">
                {(
                  (markets.reduce((s, m) => s + (m.avg_conf ?? 0), 0) /
                    markets.length) *
                  100
                ).toFixed(0)}
                %
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

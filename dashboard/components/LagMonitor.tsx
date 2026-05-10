"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, ReferenceLine,
  Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

const MARKETS = [
  { key: "BTC 5-Min Up/Down",  label: "BTC 5M",  color: "#f7931a" },
  { key: "ETH 5-Min Up/Down",  label: "ETH 5M",  color: "#627eea" },
  { key: "BTC 15-Min Up/Down", label: "BTC 15M", color: "#ffb347" },
  { key: "ETH 15-Min Up/Down", label: "ETH 15M", color: "#a78bfa" },
] as const;

interface LatestRow {
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
  ts: string;
}

interface SeriesPoint {
  ts: string;
  spot_change_pct: number;
  poly_yes: number | null;
  fair_yes: number | null;
  lag_pct: number | null;
  signal: string;
  window_sec_in: number;
}

interface LagApiResponse {
  latestPerMarket: LatestRow[];
  series: SeriesPoint[];
  recentSignals: Array<{
    ts: string; market: string; signal: string; lag_pct: number;
    spot_change_pct: number; poly_yes: number; fair_yes: number; window_sec_in: number;
  }>;
  stats24h: { samples: number; edges: number; avg_abs_lag: number | null; max_abs_lag: number | null };
}

export function LagMonitor() {
  const [data,   setData]   = useState<LagApiResponse | null>(null);
  const [active, setActive] = useState<string>("BTC 5-Min Up/Down");

  const load = useCallback(async () => {
    try {
      const url = `/api/lag?market=${encodeURIComponent(active)}&limit=120`;
      const res = await fetch(url);
      if (res.ok) setData(await res.json());
    } catch { /* ignore */ }
  }, [active]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, [load]);

  const latestForActive = data?.latestPerMarket?.find(r => r.market === active);
  const series          = data?.series ?? [];
  const tabCfg          = MARKETS.find(m => m.key === active) ?? MARKETS[0];

  return (
    <div className="bx" style={{ marginTop: 12 }}>
      <span className="c-tl"></span><span className="c-tr"></span><span className="c-bl"></span><span className="c-br"></span>

      {/* ── Header ──────────────────────────────────────── */}
      <div className="panel-head" style={{ marginBottom: 10 }}>
        <div className="panel-title mono upper">
          ⚡ Spot ↔ Poly Lag Monitor
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <div className="pill-tag" style={{
            background: "rgba(247,147,26,.08)",
            borderColor: "rgba(247,147,26,.3)",
            color: "#f7931a",
          }}>
            BINANCE WS · 1s
          </div>
          <div className="pill-tag">
            {data?.stats24h.samples ?? 0} probek/24h
          </div>
        </div>
      </div>

      {/* ── Description ───────────────────────────────── */}
      <div style={{
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11, color: "var(--ink-3)",
        marginBottom: 12, lineHeight: 1.5,
      }}>
        Mierzy rozbieznosc miedzy ruchem spot (Binance WS, sub-sec) a midpointem
        Polymarket CLOB. Gdy <b style={{ color: "#f7931a" }}>|lag| {">"} 17.4pp</b> (95. percentyl v2),
        rynek nie dogonil jeszcze spota — potencjalny edge.
        <br/>Wykalibrowane 2026-05-10 · sensitivity 286-598 · R² {">"} 0.68
        <br/>Strategia <b style={{ color: "#5cf0a4" }}>Double Confirmation</b>: Chronos + Lag zgodne → 68.4% WR (19 trades)
      </div>

      {/* ── Market tabs ─ */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {MARKETS.map(m => {
          const r       = data?.latestPerMarket?.find(x => x.market === m.key);
          const lag     = r?.lag_pct ?? null;
          const isActive = active === m.key;
          const sigDot  = r?.signal === "BUY_YES" ? "var(--green)"
                        : r?.signal === "BUY_NO"  ? "var(--hot)"
                        : "var(--ink-4)";
          return (
            <button
              key={m.key}
              onClick={() => setActive(m.key)}
              style={{
                cursor: "pointer",
                background: isActive ? `${m.color}18` : "transparent",
                border: `1px solid ${isActive ? m.color : "var(--line-2)"}`,
                borderRadius: 999,
                padding: "6px 12px",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 12,
                color: isActive ? m.color : "var(--ink-3)",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: sigDot,
                boxShadow: r?.signal !== "NONE" && r ? `0 0 6px ${sigDot}` : "none",
              }} />
              {m.label}
              {lag !== null && (
                <span style={{
                  fontSize: 10,
                  color: Math.abs(lag) > 17.4 ? m.color : "var(--ink-4)",
                  fontWeight: 600,
                }}>
                  {lag >= 0 ? "+" : ""}{lag.toFixed(2)}pp
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Live snapshot ── */}
      {latestForActive ? (
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 10,
          padding: "12px",
          background: "rgba(255,255,255,.02)",
          border: `1px solid ${tabCfg.color}25`,
          borderRadius: 8,
          marginBottom: 12,
        }}>
          <div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: "var(--ink-3)", letterSpacing: ".12em" }}>SPOT NOW</div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 16, fontWeight: 600, color: "var(--ink)", marginTop: 4 }}>
              ${latestForActive.spot_now.toFixed(2)}
            </div>
            <div style={{
              fontFamily: "JetBrains Mono", fontSize: 11,
              color: latestForActive.spot_change_pct >= 0 ? "var(--green)" : "var(--hot)",
              marginTop: 2,
            }}>
              {latestForActive.spot_change_pct >= 0 ? "+" : ""}{latestForActive.spot_change_pct.toFixed(3)}% vs open
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: "var(--ink-3)", letterSpacing: ".12em" }}>POLY YES</div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 16, fontWeight: 600, color: tabCfg.color, marginTop: 4 }}>
              {latestForActive.poly_yes !== null ? latestForActive.poly_yes.toFixed(3) : "—"}
            </div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              {latestForActive.poly_yes !== null ? `payout ${(1/latestForActive.poly_yes).toFixed(2)}x` : "no data"}
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: "var(--ink-3)", letterSpacing: ".12em" }}>FAIR YES</div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 16, fontWeight: 600, color: "var(--ink-2)", marginTop: 4 }}>
              {latestForActive.fair_yes !== null ? latestForActive.fair_yes.toFixed(3) : "—"}
            </div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
              wg modelu spot
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: "var(--ink-3)", letterSpacing: ".12em" }}>LAG</div>
            <div style={{
              fontFamily: "JetBrains Mono", fontSize: 18, fontWeight: 700, marginTop: 4,
              color: latestForActive.lag_pct === null ? "var(--ink-4)"
                    : Math.abs(latestForActive.lag_pct) > 17.4 ? "#f7931a"
                    : latestForActive.lag_pct >= 0 ? "var(--green)" : "var(--hot)",
            }}>
              {latestForActive.lag_pct !== null
                ? `${latestForActive.lag_pct >= 0 ? "+" : ""}${latestForActive.lag_pct.toFixed(2)}pp`
                : "—"}
            </div>
            <div style={{
              fontFamily: "JetBrains Mono", fontSize: 11, marginTop: 2,
              color: latestForActive.signal === "BUY_YES" ? "var(--green)"
                   : latestForActive.signal === "BUY_NO"  ? "var(--hot)"
                   : "var(--ink-4)",
              fontWeight: 600,
            }}>
              {latestForActive.signal === "BUY_YES" ? "🟢 BUY YES (poly low)"
                : latestForActive.signal === "BUY_NO"  ? "🔴 BUY NO (poly high)"
                : "—"}
            </div>
          </div>
        </div>
      ) : (
        <div style={{
          padding: 24, textAlign: "center",
          color: "var(--ink-3)", fontFamily: "JetBrains Mono", fontSize: 12,
          border: "1px dashed var(--line-2)", borderRadius: 8, marginBottom: 12,
        }}>
          // awaiting Binance WS feed... start scanner bot //
        </div>
      )}

      {/* ── Lag chart ── */}
      <div style={{ height: 160, marginBottom: 8 }}>
        {series.length < 2 ? (
          <div style={{
            height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--ink-3)", fontFamily: "JetBrains Mono", fontSize: 11,
          }}>
            // collecting samples (1 every 5s) //
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series.map((s, i) => ({ ...s, idx: i }))} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="lag-grad-pos" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#5cf0a4" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#5cf0a4" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="lag-grad-neg" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%"   stopColor="#ff4a8a" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#ff4a8a" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 6" stroke="rgba(255,255,255,.04)" />
              <XAxis dataKey="idx" tick={{ fontSize: 9, fill: "var(--ink-3)" }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fontSize: 9, fill: "var(--ink-3)", fontFamily: "JetBrains Mono" }}
                axisLine={false} tickLine={false}
                tickFormatter={v => `${v.toFixed(1)}pp`}
                domain={["auto", "auto"]}
              />
              <ReferenceLine y={0}   stroke="rgba(255,255,255,.18)" strokeDasharray="2 2" />
              <ReferenceLine y={17.4}  stroke="rgba(247,147,26,.4)"   strokeDasharray="3 3" />
              <ReferenceLine y={-17.4} stroke="rgba(247,147,26,.4)"   strokeDasharray="3 3" />
              <Tooltip
                contentStyle={{
                  background: "#140a10", border: `1px solid ${tabCfg.color}40`,
                  borderRadius: 6, fontSize: 11, fontFamily: "JetBrains Mono",
                }}
                labelStyle={{ color: "var(--ink-3)" }}
                formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v.toFixed(2)}pp`, "Lag"]}
                labelFormatter={(_, payload) => {
                  const p = payload?.[0]?.payload;
                  if (!p) return "";
                  const ts = String(p.ts).slice(11, 19);
                  return `${ts} · spot ${p.spot_change_pct >= 0 ? "+" : ""}${p.spot_change_pct.toFixed(3)}%`;
                }}
              />
              <Area
                type="monotone"
                dataKey="lag_pct"
                stroke={tabCfg.color}
                strokeWidth={1.5}
                fill="url(#lag-grad-pos)"
                dot={false}
                activeDot={{ r: 3, fill: tabCfg.color, strokeWidth: 0 }}
                connectNulls
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Stats 24h ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
        gap: 8, paddingTop: 10, borderTop: "1px solid var(--line)",
      }}>
        {[
          { l: "EDGES 24H", v: data?.stats24h.edges ?? 0, fmt: (x: number) => x.toString(), color: "#f7931a" },
          { l: "AVG |LAG|", v: data?.stats24h.avg_abs_lag ?? 0, fmt: (x: number) => `${x.toFixed(2)}pp` },
          { l: "MAX |LAG|", v: data?.stats24h.max_abs_lag ?? 0, fmt: (x: number) => `${x.toFixed(2)}pp` },
          { l: "WIN %", v: data ? (data.stats24h.samples ? (data.stats24h.edges / data.stats24h.samples) * 100 : 0) : 0, fmt: (x: number) => `${x.toFixed(1)}%` },
        ].map(({ l, v, fmt, color }) => (
          <div key={l}>
            <div style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: "var(--ink-3)", letterSpacing: ".1em" }}>{l}</div>
            <div style={{
              fontFamily: "JetBrains Mono", fontSize: 18, fontWeight: 600, marginTop: 3,
              color: color ?? "var(--ink)",
            }}>
              {fmt(typeof v === "number" ? v : 0)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
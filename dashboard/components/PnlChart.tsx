"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

const TABS = [
  { key: "ALL",               label: "ALL",     color: "#5cf0a4" },
  { key: "BTC 5-Min Up/Down", label: "BTC 5M",  color: "#f7931a" },
  { key: "ETH 5-Min Up/Down", label: "ETH 5M",  color: "#627eea" },
  { key: "BTC 15-Min Up/Down",label: "BTC 15M", color: "#ffb347" },
  { key: "ETH 15-Min Up/Down",label: "ETH 15M", color: "#a78bfa" },
] as const;

interface SimResult {
  curve: { t: number; bk: number; ts: string }[];
  stats: {
    trades: number; wins: number; losses: number;
    winRate: number; pnl: number; roi: number; bankroll: number;
  };
}

type PnlData = Record<string, SimResult>;

// Custom tooltip
function CustomTooltip({ active, payload, color }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { ts: string; t: number } }>;
  color: string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div style={{
      background: "#140a10", border: `1px solid ${color}40`,
      borderRadius: 8, padding: "8px 12px",
      fontFamily: "JetBrains Mono, monospace", fontSize: 12,
    }}>
      <div style={{ color: "var(--ink-3)", fontSize: 10, marginBottom: 4 }}>
        Trade #{d.payload.t} · {d.payload.ts}
      </div>
      <div style={{ color, fontWeight: 600, fontSize: 14 }}>
        ${d.value.toFixed(2)}
      </div>
    </div>
  );
}

export function PnlChart() {
  const [data, setData]         = useState<PnlData | null>(null);
  const [activeTab, setActiveTab] = useState<string>("ALL");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pnl");
      if (res.ok) setData(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const tabCfg  = TABS.find(t => t.key === activeTab) ?? TABS[0];
  const current = data?.[activeTab];
  const stats   = current?.stats;
  const curve   = current?.curve ?? [];

  const isProfit = (stats?.pnl ?? 0) >= 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 12 }}>

      {/* ── Tab selector ─────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {TABS.map(tab => {
          const s     = data?.[tab.key]?.stats;
          const isPos = (s?.pnl ?? 0) >= 0;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                cursor: "pointer",
                background: active ? `${tab.color}18` : "transparent",
                border: `1px solid ${active ? tab.color : "var(--line-2)"}`,
                borderRadius: 999,
                padding: "6px 14px",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 13,
                color: active ? tab.color : "var(--ink-3)",
                display: "flex", alignItems: "center", gap: 6,
                transition: "all .15s ease",
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: s ? (isPos ? tab.color : "var(--hot)") : "var(--ink-4)",
                boxShadow: active ? `0 0 6px ${tab.color}` : "none",
              }} />
              {tab.label}
              {s && (
                <span style={{ fontSize: 10, color: isPos ? tab.color : "var(--hot)" }}>
                  {s.pnl >= 0 ? "+" : ""}{s.pnl.toFixed(2)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Chart ────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 220 }}>
        {curve.length < 2 ? (
          <div style={{
            height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--ink-3)", fontFamily: "JetBrains Mono, monospace", fontSize: 12,
          }}>
            // awaiting live POLY trades — collecting data //
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={curve} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${activeTab}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={tabCfg.color} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={tabCfg.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 6" stroke="rgba(255,255,255,.04)" />
              <XAxis
                dataKey="t"
                tick={{ fontSize: 9, fill: "var(--ink-3)", fontFamily: "JetBrains Mono" }}
                axisLine={false} tickLine={false}
                label={{ value: "Trade #", position: "insideBottomRight", offset: -4, fontSize: 9, fill: "var(--ink-3)" }}
              />
              <YAxis
                tick={{ fontSize: 9, fill: "var(--ink-3)", fontFamily: "JetBrains Mono" }}
                axisLine={false} tickLine={false}
                tickFormatter={v => `$${v.toFixed(0)}`}
                domain={["auto", "auto"]}
              />
              <ReferenceLine y={100} stroke="rgba(255,255,255,.12)" strokeDasharray="4 4" />
              <Tooltip content={<CustomTooltip color={tabCfg.color} />} />
              <Area
                type="monotone"
                dataKey="bk"
                stroke={tabCfg.color}
                strokeWidth={1.5}
                fill={`url(#grad-${activeTab})`}
                dot={false}
                activeDot={{ r: 4, fill: tabCfg.color, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Stats grid ───────────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
        gap: 10, borderTop: "1px solid var(--line)", paddingTop: 12,
      }}>
        {[
          { l: "TRADES",  v: stats?.trades ?? 0,   fmt: (x: number) => x.toString() },
          { l: "WIN RATE",v: stats?.winRate ?? 0,   fmt: (x: number) => `${x.toFixed(1)}%`, color: (x: number) => x >= 50 ? "var(--green)" : "var(--hot)" },
          { l: "PNL",     v: stats?.pnl ?? 0,       fmt: (x: number) => `${x >= 0 ? "+" : ""}$${x.toFixed(2)}`, color: (x: number) => x >= 0 ? "var(--green)" : "var(--hot)" },
          { l: "ROI",     v: stats?.roi ?? 0,       fmt: (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`, color: (x: number) => x >= 0 ? "var(--green)" : "var(--hot)" },
        ].map(({ l, v, fmt, color }) => (
          <div key={l}>
            <div style={{ fontSize: 12, color: "var(--ink-3)", letterSpacing: ".12em", textTransform: "uppercase", fontFamily: "JetBrains Mono" }}>{l}</div>
            <div style={{
              fontFamily: "JetBrains Mono, monospace", fontSize: 24, fontWeight: 600,
              marginTop: 4,
              color: color ? color(v) : "var(--ink)",
            }}>
              {fmt(v)}
            </div>
          </div>
        ))}
      </div>

      {/* ── Mini tabela wszystkich rynków ────────────────────── */}
      {data && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 50px 55px 65px 60px",
            gap: 6, marginBottom: 4,
          }}>
            {["RYNEK", "TR", "WIN%", "PNL", "ROI"].map(h => (
              <div key={h} style={{ fontSize: 11, color: "var(--ink-4)", letterSpacing: ".1em", fontFamily: "JetBrains Mono" }}>{h}</div>
            ))}
          </div>
          {TABS.filter(t => t.key !== "ALL").map(tab => {
            const s = data[tab.key]?.stats;
            if (!s) return null;
            const pos = s.pnl >= 0;
            return (
              <div key={tab.key} style={{
                display: "grid", gridTemplateColumns: "1fr 50px 60px 72px 65px",
                gap: 6, padding: "6px 0",
                borderBottom: "1px dashed rgba(255,255,255,.03)",
                cursor: "pointer",
              }} onClick={() => setActiveTab(tab.key)}>
                <div style={{ fontFamily: "JetBrains Mono", fontSize: 13, fontWeight: 600, color: tab.color }}>{tab.label}</div>
                <div style={{ fontFamily: "JetBrains Mono", fontSize: 13, color: "var(--ink-2)" }}>{s.trades}</div>
                <div style={{ fontFamily: "JetBrains Mono", fontSize: 13, color: s.winRate >= 50 ? "var(--green)" : "var(--hot)" }}>{s.winRate.toFixed(1)}%</div>
                <div style={{ fontFamily: "JetBrains Mono", fontSize: 13, fontWeight: 600, color: pos ? "var(--green)" : "var(--hot)" }}>{pos ? "+" : ""}${s.pnl.toFixed(2)}</div>
                <div style={{ fontFamily: "JetBrains Mono", fontSize: 13, color: pos ? "var(--green)" : "var(--hot)" }}>{pos ? "+" : ""}{s.roi.toFixed(1)}%</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

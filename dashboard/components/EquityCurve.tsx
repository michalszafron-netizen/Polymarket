"use client";

import { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface CurvePoint {
  ts: string;
  pnl: number;
  bankroll: number;
}

interface EquityData {
  curve: CurvePoint[];
  summary: {
    bets: number;
    wins: number;
    losses: number;
    winPct: number;
    finalPnl: number;
    maxDrawdown: number;
    finalBankroll: number;
  };
}

export function EquityCurve({ market }: { market: string }) {
  const [data, setData] = useState<EquityData | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/equity?market=${encodeURIComponent(market)}`
        );
        if (!res.ok) return;
        setData(await res.json());
      } catch {
        /* ignore */
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [market]);

  if (!data || data.curve.length === 0) {
    return (
      <div
        style={{
          height: 280,
          display: "grid",
          placeItems: "center",
          color: "var(--ink-3)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
        }}
      >
        // awaiting equity data — run backfill first //
      </div>
    );
  }

  const isPositive = data.summary.finalPnl >= 0;
  const gradColor = isPositive ? "#5cf0a4" : "#ff5a3c";

  return (
    <div style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data.curve}
          margin={{ top: 8, right: 10, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={gradColor} stopOpacity={0.25} />
              <stop offset="100%" stopColor={gradColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="2 6"
            stroke="rgba(255,255,255,.04)"
            vertical={false}
          />
          <XAxis
            dataKey="ts"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 9, fill: "#7a5e54", fontFamily: "'JetBrains Mono'" }}
            tickFormatter={(ts: string) => ts.slice(5, 10)}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 9, fill: "#7a5e54", fontFamily: "'JetBrains Mono'" }}
            tickFormatter={(v: number) => `$${v >= 0 ? "+" : ""}${v}`}
          />
          <Tooltip
            contentStyle={{
              background: "#1a0d14",
              border: "1px solid #3a2030",
              borderRadius: 6,
              fontSize: 11,
              fontFamily: "'JetBrains Mono'",
              color: "#f6e9e0",
            }}
            labelFormatter={(ts: string) => `${ts}`}
            formatter={(val: number) => [`$${val >= 0 ? "+" : ""}${val}`, "PnL"]}
          />
          <Area
            type="monotone"
            dataKey="pnl"
            stroke={gradColor}
            strokeWidth={1.5}
            fill="url(#equityGrad)"
            dot={false}
            animationDuration={1200}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

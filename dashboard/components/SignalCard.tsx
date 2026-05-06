"use client";

import { useEffect, useState } from "react";

interface EdgeRow {
  direction: string;
  confidence: number;
  prob_up: number;
  prob_down: number;
  yes_price: number;
  ev: number;
  kelly: number;
  n_samples: number;
  inference_ms: number;
  ts: string;
  anchor_price: number;
}

export function SignalCard({ market }: { market: string }) {
  const [latest, setLatest] = useState<EdgeRow | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/edges?market=${encodeURIComponent(market)}&limit=1`
        );
        if (!res.ok) return;
        const rows: EdgeRow[] = await res.json();
        if (rows.length > 0) setLatest(rows[0]);
      } catch {
        /* ignore */
      }
    }
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [market]);

  if (!latest) {
    return (
      <div className="bx">
        <div className="panel-head">
          <div className="panel-title mono upper">Latest Edge</div>
        </div>
        <div className="empty-row">
          // no edge data — start scanner bot //
        </div>
      </div>
    );
  }

  const isUp   = latest.direction === "UP";
  const conf   = latest.confidence * 100;
  const ev     = latest.ev * 100;
  const kelly  = latest.kelly * 100;
  const isPoly = Math.abs(latest.yes_price - 0.51) > 0.01; // true = prawdziwa cena Polymarket

  return (
    <div className="bx">
      <div className="panel-head">
        <div className="panel-title mono upper">Latest Edge</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {/* Wskaźnik źródła ceny */}
          <div style={{
            border: `1px solid ${isPoly ? "rgba(92,240,164,.4)" : "rgba(255,209,102,.4)"}`,
            color: isPoly ? "var(--green)" : "var(--yellow)",
            borderRadius: 999, padding: "3px 9px",
            fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 5,
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%",
              background: isPoly ? "var(--green)" : "var(--yellow)",
              boxShadow: isPoly ? "0 0 6px var(--green)" : "none",
              display: "inline-block",
            }} />
            {isPoly ? "POLY LIVE" : "SIMULATED"}
          </div>
          <div className="pill-tag">{latest.ts.slice(11, 19)}</div>
        </div>
      </div>

      {/* Big direction indicator */}
      <div style={{ textAlign: "center", padding: "18px 0 12px" }}>
        <div
          className={`big-num ${isUp ? "green" : "red"}`}
          style={{ fontSize: 48 }}
        >
          {isUp ? "▲" : "▼"} {latest.direction}
        </div>
        <div
          className="mono"
          style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}
        >
          {market}
        </div>
      </div>

      {/* Confidence bar */}
      <div className="conf-row">
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
          CONF
        </span>
        <div className="conf-bar">
          <div style={{ width: `${conf}%` }} />
        </div>
        <span
          className="mono"
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: isUp ? "var(--green)" : "var(--hot)",
          }}
        >
          {conf.toFixed(1)}%
        </span>
      </div>

      {/* Mini stats grid */}
      <div className="mini-grid">
        <div className="mini">
          <div className="l">PROB UP</div>
          <div className={`v ${isUp ? "green" : ""}`}>
            {(latest.prob_up * 100).toFixed(1)}%
          </div>
        </div>
        <div className="mini">
          <div className="l">PROB DOWN</div>
          <div className={`v ${!isUp ? "hot" : ""}`}>
            {(latest.prob_down * 100).toFixed(1)}%
          </div>
        </div>
        <div className="mini">
          <div className="l">EV</div>
          <div className={`v ${ev > 0 ? "green" : "hot"}`}>
            {ev > 0 ? "+" : ""}
            {ev.toFixed(1)}%
          </div>
        </div>
        <div className="mini">
          <div className="l">KELLY</div>
          <div className="v">{kelly.toFixed(1)}%</div>
        </div>
        <div className="mini">
          <div className="l">YES PRICE</div>
          <div className="v" style={{ color: isPoly ? "var(--green)" : "var(--yellow)" }}>
            {latest.yes_price.toFixed(3)}
          </div>
        </div>
        <div className="mini">
          <div className="l">LATENCY</div>
          <div className="v">{latest.inference_ms}ms</div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

interface EdgeRow {
  id: number;
  ts: string;
  market: string;
  direction: string;
  confidence: number;
  yes_price: number;
  ev: number;
  kelly: number;
  resolved: number;
  correct: number | null;
  anchor_price: number;
  resolve_price: number | null;
}

export function TradeLedger({ market }: { market: string }) {
  const [edges, setEdges] = useState<EdgeRow[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/edges?market=${encodeURIComponent(market)}&limit=50`
        );
        if (!res.ok) return;
        setEdges(await res.json());
      } catch { /* ignore */ }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [market]);

  const wins   = edges.filter(e => e.resolved && e.correct === 1).length;
  const losses = edges.filter(e => e.resolved && e.correct === 0).length;
  const open   = edges.filter(e => !e.resolved).length;

  return (
    <div className="bx" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="panel-head">
        <div className="panel-title mono upper">Trade Ledger</div>
        <div style={{ display: "flex", gap: 6 }}>
          <span style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--green)" }}>
            {wins}W
          </span>
          <span style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--hot)" }}>
            {losses}L
          </span>
          <span style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--yellow)" }}>
            {open} OPEN
          </span>
        </div>
      </div>

      {edges.length === 0 ? (
        <div className="empty-row">// no trades yet — start scanner bot //</div>
      ) : (
        /* Przewijana lista */
        <div style={{
          overflowY: "auto",
          maxHeight: 420,
          paddingRight: 4,
          scrollbarWidth: "thin",
          scrollbarColor: "var(--line-2) transparent",
        }}>
          {edges.map((e) => {
            const isResolved = e.resolved === 1;
            const isWin      = e.correct === 1;
            const confPct    = (e.confidence * 100).toFixed(0);
            const evPct      = (e.ev * 100).toFixed(0);
            const kellyPct   = (e.kelly * 100).toFixed(0);
            const time       = e.ts.slice(11, 16);
            const isPoly     = Math.abs((e.yes_price ?? 0.51) - 0.51) > 0.01;

            const statusColor = isResolved
              ? isWin ? "var(--green)" : "var(--hot)"
              : "var(--yellow)";
            const statusBorder = isResolved
              ? isWin ? "rgba(92,240,164,.3)" : "rgba(255,59,59,.3)"
              : "rgba(255,209,102,.3)";
            const statusLabel = isResolved ? (isWin ? "WIN" : "LOSS") : "OPEN";

            return (
              <div key={e.id} style={{
                display: "grid",
                gridTemplateColumns: "1fr 52px 70px 48px",
                gap: 8,
                alignItems: "center",
                padding: "10px 0",
                borderBottom: "1px dashed rgba(255,255,255,.04)",
              }}>
                {/* Kierunek + conf + czas */}
                <div>
                  <div style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 13,
                    fontWeight: 600,
                    color: e.direction === "UP" ? "var(--green)" : "var(--hot)",
                  }}>
                    {e.direction === "UP" ? "▲" : "▼"}{" "}
                    <span style={{ color: "var(--ink)" }}>{e.direction}</span>{" "}
                    <span style={{ color: "var(--ink-2)", fontWeight: 400 }}>{confPct}%</span>
                  </div>
                  <div style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 11,
                    color: "var(--ink-3)",
                    marginTop: 2,
                    display: "flex", gap: 6,
                  }}>
                    <span>{time}</span>
                    {isPoly && (
                      <span style={{ color: "rgba(92,240,164,.6)", fontSize: 10 }}>POLY</span>
                    )}
                  </div>
                </div>

                {/* Status WIN/LOSS/OPEN */}
                <div style={{
                  border: `1px solid ${statusBorder}`,
                  color: statusColor,
                  borderRadius: 999,
                  padding: "4px 8px",
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  fontWeight: 600,
                  textAlign: "center",
                }}>
                  {statusLabel}
                </div>

                {/* EV */}
                <div style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 12,
                  fontWeight: 600,
                  color: isResolved ? (isWin ? "var(--green)" : "var(--hot)") : "var(--ink-2)",
                  textAlign: "right",
                }}>
                  EV {evPct}%
                </div>

                {/* Kelly */}
                <div style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  color: "var(--ink-3)",
                  textAlign: "right",
                }}>
                  K{kellyPct}%
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

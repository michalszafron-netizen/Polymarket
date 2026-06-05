"use client";

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

interface TradeRow {
  id:         number;
  ts:         string;
  market:     string;
  direction:  string;
  side:       string;
  yes_price:  number;
  bet_price:  number;
  ev:         number;
  size_usd:   number;
  dry_run:    boolean;
  resolved:   boolean;
  correct:    number | null;
  pnl:        number | null;
}

interface Stats {
  total:    number;
  wins:     number;
  losses:   number;
  open:     number;
  winRate:  number | null;
  totalPnl: number;
  avgEv:    number | null;
  markets:  Record<string, { trades: number; wins: number; losses: number }>;
  curve:    { ts: string; cumPnl: number }[];
}

interface ApiResponse {
  trades:    TradeRow[];
  dryStats:  Stats;
  liveStats: Stats;
}

type Mode = "dry" | "live" | "server";

interface ServerApiResponse {
  trades:    TradeRow[];
  liveStats: Stats;
}

// ts z bazy to UTC (SQLite datetime('now')) — konwertujemy na Europe/Warsaw
function toWarsawTime(utcStr: string): string {
  const dt = new Date(utcStr.replace(" ", "T") + "Z");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    month:    "2-digit",
    day:      "2-digit",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  }).formatToParts(dt);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

const MARKET_SHORT: Record<string, string> = {
  "BTC 5-Min Up/Down":  "BTC 5M",
  "ETH 5-Min Up/Down":  "ETH 5M",
  "BTC 15-Min Up/Down": "BTC 15M",
  "ETH 15-Min Up/Down": "ETH 15M",
};

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 80 }}>
      <div style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "var(--ink-3)", letterSpacing: ".1em" }}>
        {label}
      </div>
      <div style={{ fontFamily: "JetBrains Mono", fontSize: 26, fontWeight: 700, color: color ?? "var(--ink)" }}>
        {value}
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ value: number; payload: { ts: string } }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  const pnl = d.value;
  return (
    <div style={{
      background: "#140a10", border: `1px solid ${pnl >= 0 ? "rgba(92,240,164,.3)" : "rgba(255,59,59,.3)"}`,
      borderRadius: 8, padding: "8px 12px",
      fontFamily: "JetBrains Mono, monospace", fontSize: 12,
    }}>
      <div style={{ color: "var(--ink-3)", fontSize: 10, marginBottom: 4 }}>{d.payload.ts}</div>
      <div style={{ color: pnl >= 0 ? "var(--green)" : "var(--hot)", fontWeight: 600, fontSize: 14 }}>
        {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
      </div>
    </div>
  );
}

export function TradeMonitor() {
  const [data, setData]             = useState<ApiResponse | null>(null);
  const [serverData, setServerData] = useState<ServerApiResponse | null>(null);
  const [serverError, setServerError] = useState(false);
  const [mode, setMode]             = useState<Mode>("dry");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/trades");
      if (res.ok) setData(await res.json());
    } catch { /* ignore */ }
  }, []);

  const loadServer = useCallback(async () => {
    try {
      const res = await fetch("/api/server-trades");
      if (res.ok) {
        setServerData(await res.json());
        setServerError(false);
      } else {
        setServerError(true);
      }
    } catch { setServerError(true); }
  }, []);

  useEffect(() => {
    load();
    loadServer();
    const id1 = setInterval(load, 20_000);
    const id2 = setInterval(loadServer, 30_000);
    return () => { clearInterval(id1); clearInterval(id2); };
  }, [load, loadServer]);

  const stats  = mode === "server"
    ? serverData?.liveStats
    : mode === "dry" ? data?.dryStats : data?.liveStats;
  const trades = mode === "server"
    ? (serverData?.trades ?? [])
    : (data?.trades ?? []).filter(t => mode === "dry" ? t.dry_run : !t.dry_run);

  const pnlColor = (stats?.totalPnl ?? 0) >= 0 ? "var(--green)" : "var(--hot)";
  const wrColor  = stats?.winRate == null
    ? "var(--ink-3)"
    : stats.winRate >= 55 ? "var(--green)" : stats.winRate >= 50 ? "var(--yellow)" : "var(--hot)";

  return (
    <div className="bx" style={{ marginTop: 12 }}>
      {/* ─── Header ─────────────────────────────────────────────── */}
      <div className="panel-head" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="panel-title mono upper">Trade Monitor</div>
          <span style={{
            fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: 600,
            padding: "2px 8px", borderRadius: 999,
            background: mode === "dry" ? "rgba(255,209,102,.1)" : "rgba(92,240,164,.1)",
            border: `1px solid ${mode === "dry" ? "rgba(255,209,102,.4)" : "rgba(92,240,164,.4)"}`,
            color: mode === "dry" ? "var(--yellow)" : "var(--green)",
          }}>
            {mode === "dry" ? "DRY RUN" : mode === "server" ? "POLIS LIVE" : "LIVE"}
          </span>
          {mode === "server" && serverError && (
            <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: "var(--hot)", marginLeft: 6 }}>
              ● brak danych serwera
            </span>
          )}
        </div>
        {/* Mode toggle */}
        <div style={{ display: "flex", gap: 6 }}>
          {(["dry", "live", "server"] as Mode[]).map(m => (
            <button key={m} onClick={() => setMode(m)} className="pill" style={{
              cursor: "pointer",
              background: m === mode ? "rgba(255,138,91,.1)" : "transparent",
              borderColor: m === mode ? "var(--hot-2)" : "var(--line-2)",
              color: m === mode ? "var(--hot-2)" : "var(--ink-3)",
            }}>
              {m === "dry" ? "DRY RUN" : m === "server" ? "SERVER" : "LIVE"}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Stats bar ──────────────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(5, 1fr)",
        gap: 16, padding: "16px 0", borderBottom: "1px solid var(--line)",
        marginBottom: 16,
      }}>
        <StatCell label="TRADES"   value={String(stats?.total ?? 0)} />
        <StatCell label="WIN RATE" value={stats?.winRate != null ? `${stats.winRate}%` : "—"} color={wrColor} />
        <StatCell
          label="P&L"
          value={stats?.totalPnl != null ? `${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}` : "$0.00"}
          color={pnlColor}
        />
        <StatCell label="AVG EV"   value={stats?.avgEv != null ? `+${stats.avgEv}%` : "—"} color="var(--hot-2)" />
        <StatCell label="OPEN"     value={String(stats?.open ?? 0)} color="var(--yellow)" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* ─── Equity curve ───────────────────────────────────── */}
        <div>
          <div style={{ fontFamily: "JetBrains Mono", fontSize: 13, color: "var(--ink-3)", marginBottom: 10, letterSpacing: ".08em" }}>
            KRZYWA KAPITAŁU — {mode === "dry" ? "DRY RUN" : mode === "server" ? "POLIS LIVE" : "LIVE"}
          </div>
          {(stats?.curve?.length ?? 0) === 0 ? (
            <div style={{
              height: 160, display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "JetBrains Mono", fontSize: 12, color: "var(--ink-3)",
              border: "1px dashed var(--line-2)", borderRadius: 6,
            }}>
              // czekam na pierwsze trade'y //
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={stats!.curve} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3" />
                <XAxis dataKey="ts" hide />
                <YAxis
                  tickFormatter={v => `$${v}`}
                  tick={{ fill: "var(--ink-3)", fontSize: 10, fontFamily: "JetBrains Mono" }}
                  width={42}
                />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,.15)" strokeDasharray="3 3" />
                <Line
                  type="monotone" dataKey="cumPnl"
                  stroke={(stats?.totalPnl ?? 0) >= 0 ? "var(--green)" : "var(--hot)"}
                  strokeWidth={2} dot={false} activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}

          {/* Per-market breakdown */}
          {stats && Object.keys(stats.markets).length > 0 && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              {Object.entries(stats.markets).map(([mkt, s]) => (
                <div key={mkt} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: "JetBrains Mono", fontSize: 13, color: "var(--ink-3)" }}>
                    {MARKET_SHORT[mkt] ?? mkt}
                  </span>
                  <span style={{ fontFamily: "JetBrains Mono", fontSize: 13 }}>
                    <span style={{ color: "var(--green)", fontWeight: 700 }}>{s.wins}W</span>
                    {" / "}
                    <span style={{ color: "var(--hot)", fontWeight: 700 }}>{s.losses}L</span>
                    {s.trades > 0 && (
                      <span style={{ color: "var(--ink-3)", marginLeft: 8 }}>
                        ({(s.wins / s.trades * 100).toFixed(0)}%)
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ─── Trade ledger ────────────────────────────────────── */}
        <div>
          <div style={{ fontFamily: "JetBrains Mono", fontSize: 13, color: "var(--ink-3)", marginBottom: 10, letterSpacing: ".08em" }}>
            LOG TRADE'ÓW
          </div>
          {trades.length === 0 ? (
            <div style={{
              height: 160, display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "JetBrains Mono", fontSize: 12, color: "var(--ink-3)",
              border: "1px dashed var(--line-2)", borderRadius: 6,
            }}>
              // brak trade&apos;ów — czekam na sygnały //
            </div>
          ) : (
            <div style={{
              overflowY: "auto", maxHeight: 260,
              scrollbarWidth: "thin", scrollbarColor: "var(--line-2) transparent",
            }}>
              {trades.map(t => {
                const statusColor  = !t.resolved ? "var(--yellow)" : t.correct === 1 ? "var(--green)" : "var(--hot)";
                const statusLabel  = !t.resolved ? "OPEN" : t.correct === 1 ? "WIN" : "LOSS";
                const mkt          = MARKET_SHORT[t.market] ?? t.market;
                const payout       = (1 / t.bet_price).toFixed(2);
                const time         = toWarsawTime(t.ts);

                return (
                  <div key={t.id} style={{
                    display: "grid",
                    gridTemplateColumns: "72px 68px 1fr 72px 60px",
                    gap: 8, alignItems: "center",
                    padding: "10px 0",
                    borderBottom: "1px dashed rgba(255,255,255,.06)",
                    fontSize: 13, fontFamily: "JetBrains Mono",
                  }}>
                    {/* Czas + rynek */}
                    <div>
                      <div style={{ color: "var(--ink-3)", fontSize: 11 }}>{time}</div>
                      <div style={{ color: "var(--ink-2)", marginTop: 3, fontSize: 13, fontWeight: 600 }}>{mkt}</div>
                    </div>

                    {/* Kierunek */}
                    <div style={{ color: t.direction === "UP" ? "var(--green)" : "var(--hot)", fontWeight: 700, fontSize: 13 }}>
                      {t.direction === "UP" ? "▲" : "▼"} {t.side}
                    </div>

                    {/* Cena + payout */}
                    <div style={{ color: "var(--ink-2)", fontSize: 13 }}>
                      {t.bet_price.toFixed(3)}
                      <span style={{ color: "var(--ink-3)", marginLeft: 5 }}>{payout}x</span>
                    </div>

                    {/* P&L */}
                    <div style={{
                      fontWeight: 700, fontSize: 14,
                      color: t.pnl == null ? "var(--ink-3)" : t.pnl >= 0 ? "var(--green)" : "var(--hot)",
                      textAlign: "right",
                    }}>
                      {t.pnl == null ? "—" : `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`}
                    </div>

                    {/* Status */}
                    <div style={{
                      color: statusColor, fontWeight: 700, textAlign: "center",
                      border: `1px solid ${statusColor}40`, borderRadius: 999,
                      padding: "3px 8px", fontSize: 12,
                    }}>
                      {statusLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

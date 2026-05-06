"use client";

import { useEffect, useState, useCallback } from "react";
import { SignalCard } from "@/components/SignalCard";
import { PnlChart } from "@/components/PnlChart";
import { TradeLedger } from "@/components/TradeLedger";
import { StatsBar } from "@/components/StatsBar";
import { MarketYield } from "@/components/MarketYield";

const MARKETS = [
  "BTC 5-Min Up/Down",
  "ETH 5-Min Up/Down",
  "BTC 15-Min Up/Down",
  "ETH 15-Min Up/Down",
];

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
  latestEdges: Array<{
    market: string;
    direction: string;
    confidence: number;
    yes_price: number;
    prob_up: number;
    prob_down: number;
    ev: number;
    kelly: number;
    inference_ms: number;
    ts: string;
  }>;
}

interface SystemStatus {
  sidecar: { online: boolean; mode: string; model: string; model_ready?: boolean };
  scanner: { active: boolean; lastScanMin: number | null; totalEdges: number };
  database: { ok: boolean };
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
      background: ok ? 'var(--green)' : 'var(--hot)',
      boxShadow: ok ? '0 0 8px var(--green)' : '0 0 8px var(--hot)',
      marginRight: 8, flexShrink: 0,
      animation: ok ? 'pulse 1.6s infinite' : 'none',
    }} />
  );
}

export default function Home() {
  const [stats, setStats]             = useState<StatsData | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [pnlAll, setPnlAll]           = useState<{trades:number;wins:number;losses:number;winRate:number;pnl:number;roi:number;bankroll:number} | null>(null);
  const [selectedMarket, setSelectedMarket] = useState(MARKETS[0]);
  const [clock, setClock] = useState("");

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats");
      if (res.ok) setStats(await res.json());
    } catch { /* DB may not exist yet */ }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/system-status");
      if (res.ok) setSystemStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchPnl = useCallback(async () => {
    try {
      const res = await fetch("/api/pnl");
      if (res.ok) {
        const data = await res.json();
        setPnlAll(data["ALL"]?.stats ?? null);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStats();
    fetchStatus();
    fetchPnl();
    const s1 = setInterval(fetchStats, 30_000);
    const s2 = setInterval(fetchStatus, 15_000);
    const s3 = setInterval(fetchPnl, 30_000);
    return () => { clearInterval(s1); clearInterval(s2); clearInterval(s3); };
  }, [fetchStats, fetchStatus, fetchPnl]);

  const [nextResolve, setNextResolve] = useState("--:--");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(d.toUTCString().slice(17, 25) + " UTC");

      // Countdown to next 5-min or 15-min boundary (UTC)
      const intervalMin = selectedMarket.includes("15-Min") ? 15 : 5;
      const intervalMs  = intervalMin * 60 * 1000;
      const ms          = intervalMs - (Date.now() % intervalMs);
      const m           = Math.floor(ms / 60000);
      const s           = Math.floor((ms % 60000) / 1000);
      setNextResolve(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [selectedMarket]);

  const latestForMarket = stats?.latestEdges?.find(
    (e) => e.market === selectedMarket
  );

  const totalPnl = 0;
  const winPct = stats?.winRate ?? null;

  // Sprawdź czy mamy prawdziwe ceny z Polymarketu
  const hasPolyPrices = stats?.latestEdges?.some(
    (e) => Math.abs((e as { yes_price?: number }).yes_price ?? 0.51) > 0.01 && (e as { yes_price?: number }).yes_price !== undefined
  ) ?? false;

  return (
    <div className="app">
      {/* ═══ TOP BAR ═══ */}
      <div className="topbar">
        {/* Brand + System Status */}
        <div className="bx brand" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {/* Header row */}
          <div className="row1" style={{ marginBottom: 10 }}>
            <div className="logo">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 12L7 2L12 12H2Z" stroke="#ff8a5b" strokeWidth="1.4" strokeLinejoin="round" />
              </svg>
            </div>
            <h1>KRONOS</h1>
            <span className="v">TERMINAL</span>
          </div>

          {/* Status rows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>

            {/* SIDECAR */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <StatusDot ok={systemStatus?.sidecar.online ?? false} />
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.1em' }}>SIDECAR</span>
              </div>
              <span className="mono" style={{
                fontSize: 12, fontWeight: 600,
                color: systemStatus?.sidecar.online
                  ? (systemStatus.sidecar.mode === 'chronos' ? 'var(--green)' : 'var(--yellow)')
                  : 'var(--hot)',
              }}>
                {systemStatus
                  ? (systemStatus.sidecar.online
                    ? (systemStatus.sidecar.mode === 'chronos' ? '● CHRONOS AI' : '● GBM FALLBACK')
                    : '● OFFLINE')
                  : '...'}
              </span>
            </div>

            {/* SCANNER */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <StatusDot ok={systemStatus?.scanner.active ?? false} />
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.1em' }}>SCANNER</span>
              </div>
              <span className="mono" style={{
                fontSize: 12, fontWeight: 600,
                color: systemStatus?.scanner.active ? 'var(--green)' : 'var(--hot)',
              }}>
                {systemStatus
                  ? (systemStatus.scanner.active
                    ? `● AKTYWNY (${systemStatus.scanner.lastScanMin}m temu)`
                    : (systemStatus.scanner.lastScanMin !== null
                      ? `● NIEAKTYWNY (${systemStatus.scanner.lastScanMin}m)`
                      : '● BRAK DANYCH'))
                  : '...'}
              </span>
            </div>

            {/* DATABASE */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <StatusDot ok={systemStatus?.database.ok ?? false} />
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.1em' }}>BAZA DANYCH</span>
              </div>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>
                {systemStatus?.database.ok
                  ? `${systemStatus.scanner.totalEdges} sygnałów`
                  : '● BŁĄD'}
              </span>
            </div>

          </div>
        </div>

        {/* Stats cells */}
        <StatsBar stats={stats} pnlAll={pnlAll} />
      </div>

      {/* ═══ MAIN GRID ═══ */}
      <div className="main">
        {/* ─── LEFT COL ─── */}
        <div className="leftcol">
          {/* Calibration Radar */}
          <div className="bx radar" style={{ marginBottom: '12px' }}>
            <span className="c-tl"></span><span className="c-tr"></span><span className="c-bl"></span><span className="c-br"></span>
            <div className="bx-title mono">CALIBRATION RADAR</div>
            <div className="radar-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginTop: '16px' }}>
              <div className="radar-col">
                <div className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>B-VOL</div>
                <div className="mono" style={{ marginTop: '6px', fontSize: '16px', color: 'var(--green)' }}>LOW</div>
              </div>
              <div className="radar-col">
                <div className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>M-DEV</div>
                <div className="mono" style={{ marginTop: '6px', fontSize: '16px', color: 'var(--hot-2)' }}>+0.4</div>
              </div>
              <div className="radar-col">
                <div className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>S-LIQ</div>
                <div className="mono" style={{ marginTop: '6px', fontSize: '16px', color: 'var(--green)' }}>OK</div>
              </div>
            </div>
          </div>

          {/* Market selector */}
          <div className="bx">
            <div className="panel-head">
              <div className="panel-title mono upper">Signal Radar</div>
              <div className="pill-tag">
                {stats?.totalEdges ?? 0} SIGNALS
              </div>
            </div>

            {/* Market tabs */}
            <div
              style={{
                display: "flex",
                gap: 6,
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              {MARKETS.map((m) => (
                <button
                  key={m}
                  onClick={() => setSelectedMarket(m)}
                  className="pill"
                  style={{
                    cursor: "pointer",
                    background:
                      m === selectedMarket
                        ? "rgba(255,138,91,.1)"
                        : "transparent",
                    borderColor:
                      m === selectedMarket
                        ? "var(--hot-2)"
                        : "var(--line-2)",
                    color:
                      m === selectedMarket ? "var(--hot-2)" : "var(--ink-3)",
                  }}
                >
                  {m.replace(" Up/Down", "")}
                </button>
              ))}
            </div>

            {/* Latest signals */}
            {stats?.latestEdges && stats.latestEdges.length > 0 ? (
              stats.latestEdges.map((edge, i) => (
                <div className="signal-row" key={i}>
                  <div className="tag">
                    {edge.market.split(" ")[0]}{" "}
                    {edge.market.includes("5-Min") ? "5M" : "15M"}
                  </div>
                  <div className="name">
                    {edge.direction} {(edge.confidence * 100).toFixed(0)}%
                    <span className="sub">
                      EV {(edge.ev * 100).toFixed(1)}% · {edge.inference_ms}ms
                    </span>
                  </div>
                  <div
                    className={`conf ${edge.direction === "UP" ? "up" : "down"}`}
                  >
                    {(edge.confidence * 100).toFixed(1)}%
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-row">
                // awaiting signals — start scanner bot //
              </div>
            )}
          </div>

          {/* Signal Card */}
          <SignalCard market={selectedMarket} />

          {/* Model Bias */}
          <div className="bx model" style={{ marginTop: '12px' }}>
            <span className="c-tl"></span><span className="c-tr"></span><span className="c-bl"></span><span className="c-br"></span>
            <div className="bx-title mono">MODEL BIAS</div>
            <div className="bar-row" style={{ display: 'flex', alignItems: 'center', marginBottom: '10px', marginTop: '16px' }}>
              <span className="mono" style={{ fontSize: '13px', width: '44px' }}>YES</span>
              <div className="bar-bg" style={{ flex: 1, height: '5px', background: 'var(--line)', margin: '0 12px' }}><div className="bar-fill" style={{ width: '54%', height: '100%', background: 'var(--green)' }}></div></div>
              <span className="mono" style={{ fontSize: '14px', width: '44px', textAlign: 'right', color: 'var(--green)' }}>54%</span>
            </div>
            <div className="bar-row" style={{ display: 'flex', alignItems: 'center' }}>
              <span className="mono" style={{ fontSize: '13px', width: '44px' }}>NO</span>
              <div className="bar-bg" style={{ flex: 1, height: '5px', background: 'var(--line)', margin: '0 12px' }}><div className="bar-fill" style={{ width: '46%', height: '100%', background: 'var(--hot)' }}></div></div>
              <span className="mono" style={{ fontSize: '14px', width: '44px', textAlign: 'right', color: 'var(--hot)' }}>46%</span>
            </div>
            <div className="sub mono" style={{ marginTop: '12px', fontSize: '11px', color: 'var(--ink-3)' }}>CURRENT WEIGHT DISTRIBUTION</div>
          </div>
        </div>

        {/* ─── CENTER COL ─── */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {/* PNL Chart */}
          <div
            className="bx"
            style={{
              background: "linear-gradient(180deg, rgba(20,10,16,.9), rgba(15,8,12,.9))",
              flex: 1,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div className="panel-head" style={{ marginBottom: 10 }}>
              <div className="panel-title mono upper">PNL Simulator · $1/trade · POLY live</div>
              <div className="pill-tag">LIVE</div>
            </div>
            <PnlChart />
          </div>

          {/* Data source ribbon */}
          <div className="ribbon-warn" style={{
            marginTop: 12,
            borderColor: hasPolyPrices ? "rgba(92,240,164,.4)" : "rgba(198,77,255,.35)",
            background: hasPolyPrices
              ? "linear-gradient(90deg, rgba(92,240,164,.06), rgba(92,240,164,.02))"
              : "linear-gradient(90deg, rgba(198,77,255,.04), rgba(255,74,138,.02))",
          }}>
            {hasPolyPrices ? (
              <>
                <b style={{ color: "var(--green)" }}>// LIVE MODE:</b>{" "}
                Edges używają <b style={{ color: "var(--green)" }}>prawdziwych cen Polymarket CLOB</b>.
                {" "}EV i Kelly obliczone na realnych kursach rynkowych.
              </>
            ) : (
              <>
                <b>// RESEARCH MODE:</b> Edges use{" "}
                <b>simulated Polymarket odds</b> (not real CLOB data).
                Backtest accuracy ≠ live trading edge.
              </>
            )}
          </div>

          {/* Activity Ribbon */}
          <div className="bx ribbon" style={{ marginTop: '12px', padding: '10px 16px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', position: 'relative' }}>
            <span className="c-tl"></span><span className="c-tr"></span><span className="c-bl"></span><span className="c-br"></span>
            <div className="ribbon-text mono" style={{ fontSize: '10px', color: 'var(--dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              [SYS] Poly Oracle online... [OK] Fetching ByBit data... [OK] Scanning Poly markets... [OK]
            </div>
          </div>
        </div>

        {/* ─── RIGHT COL ─── */}
        <div className="rightcol">
          {/* Timer Card */}
          <div className="bx clock" style={{ marginBottom: '12px' }}>
            <span className="c-tl"></span><span className="c-tr"></span><span className="c-bl"></span><span className="c-br"></span>
            <div className="mono" style={{ fontSize: '12px', color: 'var(--ink-3)' }}>NEXT RESOLVE</div>
            <div className="clock-time mono" style={{ fontSize: '32px', letterSpacing: '-0.5px', marginTop: '6px' }}>
              {nextResolve}
            </div>
            <div className="mono" style={{ fontSize: '12px', color: 'var(--hot-2)', marginTop: '6px' }}>
              {selectedMarket}
            </div>
          </div>

          {/* Prediction Console */}
          {(() => {
            const e = latestForMarket;
            const yesP   = e?.yes_price ?? null;
            const noP    = yesP !== null ? 1 - yesP : null;
            const dir    = e?.direction ?? null;
            const conf   = e?.confidence ?? null;
            const isUp   = dir === "UP";
            const isPoly = yesP !== null && Math.abs(yesP - 0.51) > 0.01;
            return (
              <div className="bx pred" style={{ marginBottom: '12px' }}>
                <span className="c-tl"></span><span className="c-tr"></span><span className="c-bl"></span><span className="c-br"></span>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div className="bx-title mono">PREDICTION CONSOLE</div>
                  {isPoly && (
                    <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: "var(--green)", border: "1px solid rgba(92,240,164,.3)", borderRadius: 999, padding: "2px 8px" }}>
                      POLY LIVE
                    </span>
                  )}
                </div>

                {/* Kierunek modelu */}
                <div style={{ textAlign: "center", padding: "8px 0 12px", borderBottom: "1px solid var(--line)" }}>
                  <div style={{ fontFamily: "JetBrains Mono", fontSize: 28, fontWeight: 700, color: isUp ? "var(--green)" : "var(--hot)" }}>
                    {dir ? `${isUp ? "▲" : "▼"} ${dir}` : "—"}
                  </div>
                  <div style={{ fontFamily: "JetBrains Mono", fontSize: 13, color: "var(--ink-3)", marginTop: 4 }}>
                    {conf ? `${(conf * 100).toFixed(0)}% confidence` : "awaiting signal"}
                  </div>
                </div>

                {/* Ostrzeżenie przy ekstremalnych cenach */}
                {yesP !== null && (yesP > 0.85 || yesP < 0.15) && (
                  <div style={{
                    margin: "10px 0 4px",
                    padding: "6px 10px",
                    background: "rgba(255,209,102,.08)",
                    border: "1px dashed rgba(255,209,102,.4)",
                    borderRadius: 6,
                    fontFamily: "JetBrains Mono", fontSize: 11,
                    color: "var(--yellow)",
                  }}>
                    ⚠️ Ekstremalna cena — rynek prawdopodobnie blisko rozwiązania. Nie wchodź.
                  </div>
                )}

                {/* Ceny YES / NO */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
                  <div>
                    <div style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>YES PRICE</div>
                    <div style={{
                      fontFamily: "JetBrains Mono", fontSize: 22, fontWeight: 600,
                      color: yesP && yesP > 0.85 ? "var(--yellow)" : "var(--green)",
                    }}>
                      {yesP !== null ? yesP.toFixed(3) : "—"}
                    </div>
                    <div style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--ink-3)" }}>
                      {yesP !== null ? `payout ${(1/yesP).toFixed(2)}x` : ""}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>NO PRICE</div>
                    <div style={{
                      fontFamily: "JetBrains Mono", fontSize: 22, fontWeight: 600,
                      color: noP && noP < 0.15 ? "var(--yellow)" : "var(--hot)",
                    }}>
                      {noP !== null ? noP.toFixed(3) : "—"}
                    </div>
                    <div style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "var(--ink-3)" }}>
                      {noP !== null ? `payout ${(1/noP).toFixed(2)}x` : ""}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Trade Ledger */}
          <TradeLedger market={selectedMarket} />

          {/* Market Yield */}
          <MarketYield stats={stats} />
        </div>
      </div>

      {/* ═══ FOOTER ═══ */}
      <div className="footer">
        <div>// KRONOS TERMINAL · POLYMARKET RESEARCH</div>
        <div>{clock}</div>
      </div>
    </div>
  );
}

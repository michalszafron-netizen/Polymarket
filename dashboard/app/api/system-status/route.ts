import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const result: Record<string, unknown> = {
    sidecar: { online: false, mode: "unknown", model: "unknown" },
    scanner: { active: false, lastScanMin: null, totalEdges: 0 },
    database: { ok: false },
  };

  // ── Sidecar ─────────────────────────────────────────────
  try {
    const res = await fetch("http://localhost:8000/health", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      result.sidecar = {
        online: true,
        mode: data.mode ?? "unknown",
        model: data.model ?? "unknown",
        model_ready: data.model_ready ?? false,
      };
    }
  } catch {
    result.sidecar = { online: false, mode: "offline", model: "—" };
  }

  // ── Database + Scanner activity ─────────────────────────
  try {
    const db = getDb();
    const totalEdges = (
      db.prepare("SELECT COUNT(*) as count FROM edges").get() as { count: number }
    ).count;

    const lastEdge = db
      .prepare("SELECT ts FROM edges ORDER BY ts DESC LIMIT 1")
      .get() as { ts: string } | undefined;

    let lastScanMin: number | null = null;
    if (lastEdge) {
      // Timestamps in DB are UTC without 'Z' suffix — append Z to parse correctly
      const tsStr = lastEdge.ts.endsWith("Z") ? lastEdge.ts : lastEdge.ts + "Z";
      const diff = Date.now() - new Date(tsStr).getTime();
      lastScanMin = Math.floor(diff / 60000);
    }

    result.database = { ok: true };
    result.scanner = {
      active: lastScanMin !== null && lastScanMin < 10,
      lastScanMin,
      totalEdges,
    };
  } catch {
    result.database = { ok: false };
  }

  return NextResponse.json(result);
}

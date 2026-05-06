import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface EdgeRow {
  id: number;
  ts: string;
  market: string;
  direction: string;
  confidence: number;
  prob_up: number;
  prob_down: number;
  yes_price: number;
  ev: number;
  kelly: number;
  horizon_min: number;
  anchor_price: number;
  resolve_price: number | null;
  resolved: number;
  correct: number | null;
  pnl: number | null;
  n_samples: number;
  inference_ms: number;
  created_at: string;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const market = searchParams.get("market") ?? "BTC 5-Min Up/Down";
    const limit = Number(searchParams.get("limit") ?? 200);
    const resolved = searchParams.get("resolved"); // "1" for resolved only

    const db = getDb();

    let query = `
      SELECT * FROM edges
      WHERE market = ?
    `;
    const params: (string | number)[] = [market];

    if (resolved === "1") {
      query += " AND resolved = 1";
    }

    query += " ORDER BY ts DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(query).all(...params) as EdgeRow[];

    return NextResponse.json(rows);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

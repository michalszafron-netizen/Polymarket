import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const db = getDb();
    const result = db.prepare(
      `DELETE FROM edges WHERE traded = 1 AND trade_dry_run = 1`
    ).run();
    return NextResponse.json({ deleted: result.changes });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

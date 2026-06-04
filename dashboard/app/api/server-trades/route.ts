import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SERVER_URL = process.env.KRONOS_SERVER_URL ?? "http://185.28.100.191:8000";

export async function GET() {
  try {
    const res = await fetch(`${SERVER_URL}/trades`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return NextResponse.json(await res.json());
    return NextResponse.json({ error: "server error" }, { status: 502 });
  } catch {
    return NextResponse.json({ error: "server unreachable" }, { status: 503 });
  }
}

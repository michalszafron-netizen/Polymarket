import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SERVER_URL = process.env.KRONOS_SERVER_URL ?? "http://185.28.100.191:8000";

export async function GET() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        online: true,
        mode: data.mode ?? "unknown",
        model_ready: data.model_ready ?? false,
      });
    }
    return NextResponse.json({ online: false });
  } catch {
    return NextResponse.json({ online: false });
  }
}

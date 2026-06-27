import { NextResponse } from "next/server";

// Liveness probe for Docker/Coolify health monitoring. Intentionally
// unauthenticated and side-effect free — it reports only that the server is up,
// never any configuration or secrets.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true, status: "healthy" });
}

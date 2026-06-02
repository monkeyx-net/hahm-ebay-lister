import { NextRequest, NextResponse } from "next/server";
import { isEbayConfigured } from "@/lib/ebay/config";
import { EBAY_COOKIE, openConnection } from "@/lib/ebay/session";

export const dynamic = "force-dynamic";

// Lightweight check the UI calls on load: is eBay set up + connected?
export async function GET(req: NextRequest) {
  const configured = isEbayConfigured();
  const conn = await openConnection(req.cookies.get(EBAY_COOKIE)?.value);
  return NextResponse.json({ configured, connected: Boolean(conn) });
}

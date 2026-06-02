import { NextResponse } from "next/server";
import { EBAY_COOKIE } from "@/lib/ebay/session";

export const dynamic = "force-dynamic";

// Forget the stored eBay connection.
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(EBAY_COOKIE);
  return res;
}

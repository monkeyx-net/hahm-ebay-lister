import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/ebay/oauth";
import { EBAY_STATE_COOKIE } from "@/lib/ebay/session";

export const dynamic = "force-dynamic";

// Kick off the eBay connection: redirect the user to eBay's consent screen.
export async function GET() {
  try {
    const state = crypto.randomUUID();
    const url = buildAuthorizeUrl(state);
    const res = NextResponse.redirect(url);
    // Short-lived CSRF guard, verified in the callback.
    res.cookies.set(EBAY_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return res;
  } catch (e) {
    const msg = encodeURIComponent((e as Error).message);
    return NextResponse.redirect(
      new URL(`/?ebay=error&msg=${msg}`, process.env.APP_URL || "http://localhost:3000")
    );
  }
}

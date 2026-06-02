import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/ebay/oauth";
import {
  EBAY_COOKIE,
  EBAY_COOKIE_MAX_AGE,
  EBAY_STATE_COOKIE,
  connectionFromToken,
  sealConnection,
} from "@/lib/ebay/session";

export const dynamic = "force-dynamic";

function appUrl(req: NextRequest, path: string): URL {
  // Prefer an explicit APP_URL; otherwise derive from the request.
  const base = process.env.APP_URL || req.nextUrl.origin;
  return new URL(path, base);
}

// eBay redirects the user back here with ?code=... after they consent.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(EBAY_STATE_COOKIE)?.value;

  if (!code) {
    return NextResponse.redirect(appUrl(req, "/?ebay=error&msg=No+authorization+code"));
  }
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(appUrl(req, "/?ebay=error&msg=State+mismatch"));
  }

  try {
    const token = await exchangeCode(code);
    if (!token.refresh_token) {
      throw new Error("eBay did not return a refresh token.");
    }
    const sealed = await sealConnection(
      connectionFromToken(token.refresh_token, token.refresh_token_expires_in)
    );
    const res = NextResponse.redirect(appUrl(req, "/?ebay=connected"));
    res.cookies.set(EBAY_COOKIE, sealed, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: EBAY_COOKIE_MAX_AGE,
    });
    res.cookies.delete(EBAY_STATE_COOKIE);
    return res;
  } catch (e) {
    const msg = encodeURIComponent((e as Error).message);
    return NextResponse.redirect(appUrl(req, `/?ebay=error&msg=${msg}`));
  }
}

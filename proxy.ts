import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, safeNextPath, verifySessionToken } from "@/lib/auth/session";

function matches(pathname: string, path: string) {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function redirectTo(request: NextRequest, pathname: string, next?: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;
  const authed = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  // External ingest APIs authenticate with x-workdesk-key in their route handlers.
  if (matches(pathname, "/api")) return NextResponse.next();
  // Public integration docs.
  if (matches(pathname, "/docs")) return NextResponse.next();

  if (matches(pathname, "/verify")) {
    // Already logged in: skip the code prompt.
    return authed ? redirectTo(request, safeNextPath(searchParams.get("next"))) : NextResponse.next();
  }

  if (matches(pathname, "/setup")) {
    // Open while no secret is configured; afterwards owner-only (e.g. enrolling a new device).
    const configured = !!process.env.TOTP_SECRET?.trim();
    return configured && !authed ? redirectTo(request, "/verify") : NextResponse.next();
  }

  return authed ? NextResponse.next() : redirectTo(request, "/verify", pathname + search);
}

export const config = {
  // Everything except Next internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};

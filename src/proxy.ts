import { NextResponse, type NextRequest } from "next/server";
import { authConfig, SESSION_COOKIE, verifySession } from "@/lib/auth";

/** Sends anyone who isn't signed in to /login (only when TEAM_CODE is set). */
export function proxy(request: NextRequest) {
  const cfg = authConfig();
  if (!cfg) return NextResponse.next();
  if (verifySession(request.cookies.get(SESSION_COOKIE)?.value, cfg.secret)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) return new NextResponse("Sign in first.", { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the sign-in page and Next's own static files.
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
};

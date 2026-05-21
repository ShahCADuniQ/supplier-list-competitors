import { NextResponse } from "next/server";

// GET /api/signup-role/<role>
//
// Lightweight "role chooser" gate that runs before Clerk. It writes the
// role hint to a cookie (so it survives Clerk's OAuth redirect, browser
// tab close, or anything else that would strip the URL param), then
// 302's straight on to /sign-up?role=<role>.
//
// Why this exists: Next 16 won't let server component pages call
// cookies().set(). The only ergonomic places to write a cookie are
// route handlers and server actions. /get-started's role cards link
// here so the cookie is set BEFORE Clerk takes over; getOrCreateProfile
// reads the cookie on the very first authenticated request and persists
// pending_signup_role to user_profiles, then clears the cookie.
//
// Public route (added to proxy.ts's matcher) so it works pre-auth.

const SIGNUP_ROLE_COOKIE = "cdq_signup_role";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

const VALID_ROLES = new Set(["engineering", "supplier", "retailer"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ role: string }> },
) {
  const { role } = await params;

  if (!VALID_ROLES.has(role)) {
    // Unknown role — bounce to the chooser so the user picks again.
    return NextResponse.redirect(new URL("/get-started", req.url));
  }

  const res = NextResponse.redirect(new URL(`/sign-up?role=${role}`, req.url));
  res.cookies.set(SIGNUP_ROLE_COOKIE, role, {
    maxAge: COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    // HttpOnly + Secure relaxed for dev (localhost over HTTP). The
    // cookie value is one of three enum strings — no PII, no token.
    httpOnly: false,
    path: "/",
  });
  return res;
}

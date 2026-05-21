import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes — anything reachable WITHOUT signing in. Everything else
// hits `auth.protect()` and bounces unauth users to /sign-in.
//
// CRITICAL: "/" must be public. The home page itself decides whether to
// render the marketing landing (signed out), the supplier portal redirect,
// the retailer portal redirect, or the buyer dashboard (staff). If the
// proxy forces a sign-in on "/", the public landing page is never reachable
// and the only thing visitors see is the Clerk sign-in card.
const isPublicRoute = createRouteMatcher([
  "/",                       // marketing landing page (SignedOutHero)
  "/sign-in(.*)",            // Clerk sign-in
  "/sign-up(.*)",            // Clerk sign-up (with ?role=... hint)
  "/get-started(.*)",        // role chooser (engineering / supplier / retailer)
  "/api/signup-role/(.*)",   // role-hint cookie setter (pre-Clerk)
  "/api/webhooks(.*)",       // Clerk + Stripe webhooks
  "/vendor/(.*)",            // magic-link supplier portal (token-authed)
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};

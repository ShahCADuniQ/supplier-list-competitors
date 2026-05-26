import Link from "next/link";
import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { CADUNIQ_PRODUCT_LABEL } from "@/lib/client-config";
import CaduniqLogo from "@/components/CaduniqLogo";
import ThemeToggle from "@/components/ThemeToggle";
import ScrollAwareTopNav from "@/components/ScrollAwareTopNav";

// Role-hint persistence: see /api/signup-role/[role]/route.ts.
// /get-started → role card → /api/signup-role/<role> (sets cookie,
// redirects to /sign-up?role=<role>). The cookie is later consumed by
// getOrCreateProfile() to stamp pending_signup_role on the new user
// profile, which survives Clerk's OAuth roundtrip even if the URL
// param doesn't.

// Custom sign-up page. The /get-started chooser links here with
// `?role=engineering | supplier | retailer`. Clerk strips query params
// when it redirects after sign-up, so we forward the role through via
// `forceRedirectUrl` so the onboarding wizard at /onboarding picks the
// right form.
//
// IMPORTANT: if the user is ALREADY signed in (which happens when an
// unfinished signup gets bounced through /get-started a second time),
// rendering the <SignUp/> component would force Clerk to do a slow
// client-side redirect to forceRedirectUrl. In dev mode the Clerk JS
// can take several seconds to load and the user sees a blank "rendering
// forever" screen. We short-circuit that by redirecting server-side
// straight to /onboarding?role=X.

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Sign up · ${CADUNIQ_PRODUCT_LABEL}`,
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const params = await searchParams;
  const role =
    params.role === "supplier" ? "supplier"
    : params.role === "retailer" ? "retailer"
    : params.role === "engineering" ? "engineering"
    : null;

  const onboardingUrl = role ? `/onboarding?role=${role}` : "/onboarding";

  // Already signed in? Skip the Clerk component entirely.
  const { userId } = await auth();
  if (userId) {
    redirect(onboardingUrl);
  }
  const roleLabel =
    role === "supplier" ? "as a supplier"
    : role === "retailer" ? "as a retailer"
    : role === "engineering" ? "as a designer/engineering company"
    : "";

  return (
    <main
      style={{
        minHeight: "100vh",
        background: `
          linear-gradient(
            170deg,
            color-mix(in srgb, var(--lb-accent) 6%, transparent) 0%,
            transparent 50%,
            color-mix(in srgb, var(--lb-vivid-orange) 5%, transparent) 100%
          ),
          var(--lb-bg)
        `,
        color: "var(--lb-text)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ScrollAwareTopNav padding="16px 28px">
        <CaduniqLogo href="/" height={80} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ThemeToggle />
          <Link href="/" style={{
            padding: "8px 16px", fontSize: 13.5, fontWeight: 600,
            color: "var(--lb-text-2)", textDecoration: "none",
          }}>← Home</Link>
          <Link href="/sign-in" style={{
            padding: "8px 18px", fontSize: 13.5, fontWeight: 700,
            borderRadius: 999, color: "var(--lb-text)",
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)", textDecoration: "none",
          }}>Sign in</Link>
        </div>
      </ScrollAwareTopNav>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ width: "100%", maxWidth: 440 }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <h1 style={{
              margin: "0 0 6px", fontSize: 28, fontWeight: 800,
              letterSpacing: "-0.02em", color: "var(--lb-text)",
            }}>
              Create your account
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: "var(--lb-text-2)" }}>
              {role
                ? <>Signing up <strong>{roleLabel}</strong>. Step 2 (your company info) opens after this.</>
                : <>Choose a role first on <Link href="/get-started" style={{ color: "var(--lb-accent)", fontWeight: 600 }}>/get-started</Link> so we can route you to the right onboarding.</>}
            </p>
          </div>
          <SignUp
            path="/sign-up"
            routing="path"
            signInUrl="/sign-in"
            fallbackRedirectUrl={onboardingUrl}
            forceRedirectUrl={onboardingUrl}
            appearance={{
              elements: {
                rootBox: { width: "100%" },
                card: {
                  boxShadow: "0 8px 32px rgba(15,23,42,0.10)",
                  border: "1px solid var(--lb-border)",
                  borderRadius: 16,
                },
                headerTitle: { display: "none" },
                headerSubtitle: { display: "none" },
                footer: { borderTop: "1px solid var(--lb-border)" },
              },
            }}
          />
        </div>
      </div>
    </main>
  );
}

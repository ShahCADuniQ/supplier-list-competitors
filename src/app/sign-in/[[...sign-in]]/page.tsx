import Link from "next/link";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { CADUNIQ_PRODUCT_LABEL } from "@/lib/client-config";
import CaduniqLogo from "@/components/CaduniqLogo";
import ThemeToggle from "@/components/ThemeToggle";
import ScrollAwareTopNav from "@/components/ScrollAwareTopNav";

// Custom sign-in page. Without explicit `path` + `routing="path"` props
// Clerk falls back to its hosted Account Portal at rested-eel-76.accounts.dev
// which bounces users off-domain instead of letting them sign in inline.
//
// If the user is already signed in we skip the Clerk component and
// redirect server-side to /, where Home() decides the right destination
// (dashboard / portal / retailer / resume signup). Letting Clerk handle
// it would do a slow client-side redirect that looks like a hung page.

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Sign in · ${CADUNIQ_PRODUCT_LABEL}`,
};

export default async function SignInPage() {
  const { userId } = await auth();
  if (userId) {
    redirect("/");
  }
  return (
    <main
      style={{
        minHeight: "100vh",
        // Theme-aware: tinted overlay on top of the base --lb-bg so this
        // background flips correctly between light and dark mode.
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
      {/* Sticky top nav so the user can always return to the landing page. */}
      {/* "Sign up" in the corner mirrors what the user asked for: standard */}
      {/* SaaS pattern — corner CTAs visible on every public page. */}
      <ScrollAwareTopNav padding="16px 28px">
        <CaduniqLogo href="/" height={80} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <ThemeToggle />
          <Link href="/" style={{
            padding: "8px 16px", fontSize: 13.5, fontWeight: 600,
            color: "var(--lb-text-2)", textDecoration: "none",
          }}>← Home</Link>
          <Link href="/get-started" style={{
            padding: "8px 18px", fontSize: 13.5, fontWeight: 700,
            borderRadius: 999, color: "#fff",
            background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
            border: "1px solid #2563eb", textDecoration: "none",
          }}>Sign up →</Link>
        </div>
      </ScrollAwareTopNav>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ width: "100%", maxWidth: 440 }}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <h1 style={{
              margin: "0 0 6px", fontSize: 28, fontWeight: 800,
              letterSpacing: "-0.02em", color: "var(--lb-text)",
            }}>
              Welcome back
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: "var(--lb-text-2)" }}>
              Sign in to your {CADUNIQ_PRODUCT_LABEL} workspace.
            </p>
          </div>
          <SignIn
            path="/sign-in"
            routing="path"
            signUpUrl="/sign-up"
            fallbackRedirectUrl="/"
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

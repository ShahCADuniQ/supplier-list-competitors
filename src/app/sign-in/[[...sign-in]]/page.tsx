import Link from "next/link";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { CADUNIQ_PRODUCT_LABEL } from "@/lib/client-config";

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
        background: "linear-gradient(170deg, #eef2ff 0%, #f8f9fc 50%, #fdf2f8 100%)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Sticky top nav so the user can always return to the landing page. */}
      {/* "Sign up" in the corner mirrors what the user asked for: standard */}
      {/* SaaS pattern — corner CTAs visible on every public page. */}
      <header style={{
        position: "sticky", top: 0, zIndex: 50,
        background: "rgba(255,255,255,0.85)", backdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--lb-border)",
        padding: "14px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <Link href="/" style={{
          display: "flex", alignItems: "center", gap: 10,
          textDecoration: "none", color: "var(--lb-text)",
        }}>
          <span aria-hidden style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, borderRadius: 10,
            background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #ea580c 100%)",
            color: "#fff", fontWeight: 800, fontSize: 18, letterSpacing: "-0.04em",
          }}>C</span>
          <span style={{ fontWeight: 800, fontSize: 19, letterSpacing: "-0.015em" }}>
            CADuniQ <span style={{ fontWeight: 500, color: "var(--lb-text-2)" }}>Manufacturing</span>
          </span>
        </Link>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
      </header>

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

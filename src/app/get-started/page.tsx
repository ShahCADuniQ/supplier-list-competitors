import Link from "next/link";
import { auth } from "@clerk/nextjs/server";

// Public sign-up chooser. Three cards: Engineering Company / Supplier /
// Retailer. Each links into Clerk's sign-up with a `role` hint that the
// post-signup onboarding wizard reads to decide which collection flow to
// run. No data is stored on this page itself; auth happens in Clerk.
//
// The page is also reachable for ALREADY-signed-in users who never
// finished onboarding (the home page routes them here when role=pending
// and no claim is on file). In that case the heading flips from "Tell
// us who you are" to "Resume your signup" and we surface a sign-out
// shortcut in case they picked the wrong account.

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Get started · CADuniQ",
  description: "Choose your account type to sign up for CADuniQ.",
};

const CARD_BTN: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "11px 22px",
  fontSize: 14,
  fontWeight: 700,
  borderRadius: 999,
  textDecoration: "none",
  color: "#fff",
  border: "none",
  boxShadow: "0 4px 14px rgba(37,99,235,0.22)",
};

export default async function GetStartedPage() {
  // Detect whether this is a brand-new visitor or a signed-in user who
  // got bounced here from the home page because their signup is
  // unfinished. We use only auth() (fast — reads the session cookie)
  // and deliberately skip currentUser() because that's an HTTP call to
  // Clerk's API that can add 500-1000ms per render in dev mode.
  const { userId } = await auth();
  const signedIn = Boolean(userId);

  return (
    <main style={{
      minHeight: "100vh",
      background: "linear-gradient(170deg, #eef2ff 0%, #f8f9fc 40%, #fdf2f8 100%)",
      padding: "clamp(48px, 8vw, 96px) 24px",
    }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        {/* HEADER */}
        <header style={{ textAlign: "center", marginBottom: 48 }}>
          <Link href="/" style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            color: "var(--lb-text-3)", textDecoration: "none", fontSize: 13,
            marginBottom: 24,
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, borderRadius: 7,
              background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #ea580c 100%)",
              color: "#fff", fontWeight: 800, fontSize: 13,
            }}>C</span>
            <strong style={{ color: "var(--lb-text)" }}>CADuniQ</strong>
          </Link>
          <h1 style={{
            margin: 0, fontSize: "clamp(28px, 4vw, 44px)",
            fontWeight: 800, letterSpacing: "-0.02em", color: "var(--lb-text)",
          }}>
            {signedIn ? "Let's finish setting up your account." : "Tell us who you are."}
          </h1>
          <p style={{
            margin: "12px auto 0", maxWidth: 580,
            fontSize: 15.5, color: "var(--lb-text-2)", lineHeight: 1.6,
          }}>
            {signedIn ? (
              <>
                You&apos;re signed in. Pick the role that describes your company
                and we&apos;ll take you straight back into onboarding.
              </>
            ) : (
              <>
                Different sign-up for different roles, but everyone lands on the
                same platform underneath. Already have an account?{" "}
                <Link href="/sign-in" style={{ color: "var(--lb-accent)", fontWeight: 600 }}>Sign in here.</Link>
              </>
            )}
          </p>
        </header>

        {/* THREE CARDS — Engineering Company / Supplier / Retailer */}
        <div style={{
          display: "grid", gap: 18,
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          maxWidth: 1100, margin: "0 auto",
        }}>
          {/* Engineering Company */}
          <article style={{
            padding: 32, borderRadius: 18,
            background: "#fff", border: "2px solid rgba(37,99,235,0.20)",
            display: "flex", flexDirection: "column", gap: 16,
            transition: "transform 200ms ease, border-color 200ms ease",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{
                width: 48, height: 48, borderRadius: 12, display: "grid", placeItems: "center",
                background: "rgba(37,99,235,0.10)", fontSize: 26,
                border: "1px solid rgba(37,99,235,0.20)",
              }}>📊</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#2563eb", letterSpacing: "0.15em" }}>
                DESIGNER / ENGINEERING COMPANY
              </span>
            </div>
            <div>
              <h2 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 800, letterSpacing: "-0.015em" }}>
                I design products
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: "var(--lb-text-2)", lineHeight: 1.55 }}>
                You upload CAD models, manage projects, find suppliers, and ship
                finished products to your customers. CADuniQ becomes your
                operations platform for sourcing, inventory, RFQs, POs, and the
                whole back-office.
              </p>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                "Manage every project, supplier, and order in one workspace",
                "Suppliers can't see what other suppliers are quoting",
                "Your buyers never see your costs or supplier list",
                "Includes a free tier. No credit card to start.",
              ].map((b, i) => (
                <li key={i} style={{ fontSize: 13, color: "var(--lb-text-2)", display: "flex", gap: 8 }}>
                  <span style={{ color: "#2563eb", fontWeight: 800, flexShrink: 0 }}>✓</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <Link href="/api/signup-role/engineering" style={{
              ...CARD_BTN,
              background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
              marginTop: 4,
            }}>
              Sign up as a designer/engineering company →
            </Link>
          </article>

          {/* Supplier */}
          <article style={{
            padding: 32, borderRadius: 18,
            background: "#fff", border: "2px solid rgba(22,163,74,0.20)",
            display: "flex", flexDirection: "column", gap: 16,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{
                width: 48, height: 48, borderRadius: 12, display: "grid", placeItems: "center",
                background: "rgba(22,163,74,0.10)", fontSize: 26,
                border: "1px solid rgba(22,163,74,0.20)",
              }}>🏭</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#16a34a", letterSpacing: "0.15em" }}>
                SUPPLIER
              </span>
            </div>
            <div>
              <h2 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 800, letterSpacing: "-0.015em" }}>
                I make parts
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: "var(--lb-text-2)", lineHeight: 1.55 }}>
                You run a machine shop, fabrication plant, electronics
                assembly, or any other manufacturing service. CADuniQ matches
                you with engineering companies that already need exactly what
                you make.
              </p>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                "Receive qualified RFQs. No cold calling, no sales effort.",
                "Build a private catalog with datasheets, IES, drawings, photos",
                "Get paid via escrow within 48 hours of QC pass",
                "The buyer's identity stays anonymous until you both agree",
              ].map((b, i) => (
                <li key={i} style={{ fontSize: 13, color: "var(--lb-text-2)", display: "flex", gap: 8 }}>
                  <span style={{ color: "#16a34a", fontWeight: 800, flexShrink: 0 }}>✓</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <Link href="/api/signup-role/supplier" style={{
              ...CARD_BTN,
              background: "linear-gradient(135deg, #16a34a 0%, #059669 100%)",
              boxShadow: "0 4px 14px rgba(22,163,74,0.22)",
              marginTop: 4,
            }}>
              Sign up as a supplier →
            </Link>
          </article>

          {/* Retailer — the third audience. These are companies that BUY */}
          {/* finished products from an engineering company (e.g. a lighting */}
          {/* retailer buying from Lightbase). They get scoped to the */}
          {/* engineering company they purchase from and see a curated */}
          {/* catalog + their own orders. */}
          <article style={{
            padding: 32, borderRadius: 18,
            background: "#fff", border: "2px solid rgba(234,88,12,0.22)",
            display: "flex", flexDirection: "column", gap: 16,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{
                width: 48, height: 48, borderRadius: 12, display: "grid", placeItems: "center",
                background: "rgba(234,88,12,0.10)", fontSize: 26,
                border: "1px solid rgba(234,88,12,0.22)",
              }}>🏬</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: "#ea580c", letterSpacing: "0.15em" }}>
                RETAILER / BUYER
              </span>
            </div>
            <div>
              <h2 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 800, letterSpacing: "-0.015em" }}>
                I buy finished products
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: "var(--lb-text-2)", lineHeight: 1.55 }}>
                You&apos;re a distributor, retail brand, or end customer
                buying finished goods from an engineering company on the
                platform. CADuniQ gives you a private buyer portal with their
                catalog, your live orders, and shipping tracking, all under their
                brand.
              </p>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                "Browse only the products your supplier has shared with you",
                "Place reorders in one click; track every shipment in real-time",
                "Compliance docs and assembly manuals attached to every PO",
                "Your supplier never sees who their competitors sell to",
              ].map((b, i) => (
                <li key={i} style={{ fontSize: 13, color: "var(--lb-text-2)", display: "flex", gap: 8 }}>
                  <span style={{ color: "#ea580c", fontWeight: 800, flexShrink: 0 }}>✓</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <Link href="/api/signup-role/retailer" style={{
              ...CARD_BTN,
              background: "linear-gradient(135deg, #ea580c 0%, #db2777 100%)",
              boxShadow: "0 4px 14px rgba(234,88,12,0.22)",
              marginTop: 4,
            }}>
              Sign up as a retailer →
            </Link>
          </article>
        </div>

        {/* CADuniQ staff note */}
        <p style={{
          margin: "40px auto 0", maxWidth: 560,
          textAlign: "center", fontSize: 12, color: "var(--lb-text-3)",
          padding: "12px 20px", borderRadius: 12,
          background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)",
        }}>
          <strong>CADuniQ staff?</strong> Sign in directly at{" "}
          <Link href="/sign-in" style={{ color: "var(--lb-accent)", fontWeight: 600 }}>
            /sign-in
          </Link>
          {" "}with your <code style={{ background: "rgba(8,145,178,0.10)", padding: "1px 6px", borderRadius: 4 }}>@caduniq.com</code> email.
        </p>
      </div>
    </main>
  );
}

import { redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, crmAccounts } from "@/db/schema";
import {
  getOrCreateProfile,
  isAdmin,
  isRetailerUser,
} from "@/lib/permissions";
import { CADUNIQ_PRODUCT_LABEL } from "@/lib/client-config";

// Retailer / buyer portal — minimal landing for the third public sign-up
// role. Admins viewing this in QA-preview see the same UI scoped to the
// supplied retailer id. The full buyer portal (catalog browsing, live
// orders, shipment tracking) is a future build; for now this confirms
// the account is live and tells the retailer what's coming.

export const dynamic = "force-dynamic";
export const metadata = { title: `Buyer portal · ${CADUNIQ_PRODUCT_LABEL}` };

export default async function RetailerPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!isRetailerUser(profile) && !isAdmin(profile)) redirect("/");

  // Pull the retailer's CRM account row (created at sign-up) so we can
  // show their company name and the engineering company they're linked
  // to. Strictly scoped: we only return THIS user's account.
  const [account] = await db
    .select()
    .from(crmAccounts)
    .where(eq(crmAccounts.ownerUserId, profile.clerkUserId))
    .limit(1);

  // If the account row has a parsed engineering-company hint in notes,
  // surface it. We do NOT look up the matched client's full record —
  // that would break the anonymity invariant (the retailer can't see
  // other retailers, the engineering company can't see who else this
  // retailer buys from, etc.).
  const linkedClient = account?.notes?.match(/clientId=(\d+)/);
  let linkedClientName: string | null = null;
  if (linkedClient) {
    const [c] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, Number(linkedClient[1])))
      .limit(1);
    linkedClientName = c?.name ?? null;
  }

  return (
    <main style={{
      minHeight: "100vh",
      background: "linear-gradient(170deg, #eef2ff 0%, #f8f9fc 50%, #fdf2f8 100%)",
      padding: "clamp(32px, 6vw, 80px) 24px",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <header style={{
          padding: 24, marginBottom: 14, borderRadius: 14,
          background: "linear-gradient(135deg, rgba(234,88,12,0.12), rgba(219,39,119,0.08))",
          border: "1px solid var(--lb-border)",
        }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
            {CADUNIQ_PRODUCT_LABEL} · Buyer Portal
          </div>
          <h1 style={{ margin: "6px 0 4px", fontSize: "clamp(22px, 2.6vw, 28px)", fontWeight: 800, letterSpacing: "-0.02em" }}>
            Welcome, {account?.name ?? "buyer"} 👋
          </h1>
          <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--lb-text-2)", lineHeight: 1.55 }}>
            Your account is set up.{" "}
            {linkedClientName
              ? <>You&apos;re linked to <strong>{linkedClientName}</strong>&apos;s catalog. Their team has been notified that you signed up.</>
              : <>We&apos;re waiting to match you with the engineering company you entered at sign-up — as soon as they activate their workspace, your catalog and orders will appear here.</>
            }
          </p>
        </header>

        <section style={{
          padding: 20, marginBottom: 14, borderRadius: 12,
          background: "var(--lb-bg-elev)", border: "1px solid var(--lb-border)",
        }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 800 }}>
            What you&apos;ll see here soon
          </h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              "Browse your engineering company's curated product catalog — only what they've shared with you",
              "Place reorders in one click, see live shipment tracking from CAM to your dock",
              "Download compliance docs (CoC, FAIR, material certs) and assembly manuals attached to every PO",
              "Chat directly with their team without leaving the portal",
            ].map((b) => (
              <li key={b} style={{ fontSize: 13.5, color: "var(--lb-text-2)", display: "flex", gap: 10 }}>
                <span style={{ color: "#ea580c", fontWeight: 800, flexShrink: 0 }}>✓</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        <section style={{
          padding: 16, borderRadius: 12,
          background: "var(--lb-bg)", border: "1px dashed var(--lb-border)",
          fontSize: 12.5, color: "var(--lb-text-3)",
          textAlign: "center",
        }}>
          Your relationship stays private — your supplier never sees who their
          competitors sell to, and other buyers never see you. That&apos;s
          built into the platform.
        </section>

        <div style={{ marginTop: 24, textAlign: "center" }}>
          <Link href="/" style={{
            fontSize: 12.5, color: "var(--lb-text-3)", textDecoration: "none",
          }}>← Back to the homepage</Link>
        </div>
      </div>
    </main>
  );
}

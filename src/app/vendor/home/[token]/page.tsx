import { CLIENT_CONFIG } from "@/lib/client-config";
import { getSupplierHome } from "@/app/suppliers/rfq-actions";
import SupplierHome from "./SupplierHome";

// Public, token-gated supplier home dashboard. Lists every RFQ the
// supplier has ever been invited to + lets them jump into each per-RFQ
// portal to submit/edit their quote. The token IS the auth — anyone with
// the URL can see the supplier's invites (which the admin controls via
// the Suppliers tab in /admin: revoke / reissue / copy).

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const home = await getSupplierHome(token);
  return {
    title: home
      ? `${home.supplier.name} · Vendor Portal · ${CLIENT_CONFIG.name}`
      : `Vendor Portal · ${CLIENT_CONFIG.name}`,
  };
}

export default async function SupplierHomePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const home = await getSupplierHome(token);
  if (!home) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--lb-bg)",
          color: "var(--lb-text)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, marginBottom: 12 }}>Link expired or invalid</h1>
          <p style={{ color: "var(--lb-text-3)", fontSize: 14 }}>
            This supplier portal link is no longer valid. Reach out to your
            {` ${CLIENT_CONFIG.name} `}buyer for a new one.
          </p>
        </div>
      </div>
    );
  }
  return <SupplierHome home={home} clientName={CLIENT_CONFIG.name} />;
}

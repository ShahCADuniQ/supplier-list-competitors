import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { canViewCrm, getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { getAccountFull } from "../../actions";
import AccountDetail from "./AccountDetail";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getAccountFull(Number(id));
  return {
    title: data
      ? `${data.account.name} — CRM — ${CLIENT_CONFIG.name}`
      : `Account — ${CLIENT_CONFIG.name}`,
  };
}

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewCrm(profile)) redirect("/");
  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) notFound();
  const data = await getAccountFull(accountId);
  if (!data) notFound();
  return (
    <div
      style={{
        background: "var(--lb-bg)",
        color: "var(--lb-text)",
        minHeight: "100%",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div style={{ fontSize: 13 }}>
        <Link
          href="/crm/accounts"
          style={{
            color: "var(--lb-text-3)",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          ← All accounts
        </Link>
      </div>
      <AccountDetail
        account={data.account}
        contacts={data.contacts}
        opportunities={data.opportunities}
        activities={data.activities}
        tickets={data.tickets}
      />
    </div>
  );
}

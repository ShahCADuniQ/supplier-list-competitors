import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOrCreateProfile, canViewOee } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { getMachineDetail } from "../../actions";
import MachineDetail from "./MachineDetail";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getMachineDetail(Number(id));
  return {
    title: data
      ? `${data.machine.name} — OEE — ${CLIENT_CONFIG.name}`
      : `Machine — ${CLIENT_CONFIG.name}`,
  };
}

export default async function MachineDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewOee(profile)) redirect("/");

  const { id } = await params;
  const machineId = Number(id);
  if (!Number.isFinite(machineId)) notFound();

  const data = await getMachineDetail(machineId);
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
          href="/oee/machines"
          style={{
            color: "var(--lb-text-3)",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          ← All machines
        </Link>
      </div>
      <MachineDetail
        machine={data.machine}
        runs={data.runs}
        downtime={data.downtime}
        quality={data.quality}
        alerts={data.alerts}
        breakdown24h={data.breakdown24h}
      />
    </div>
  );
}

import { redirect } from "next/navigation";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canViewCompetitors,
  canViewEngineering,
  isAdmin,
} from "@/lib/permissions";
import ToolsTabs from "./ToolsTabs";

export const dynamic = "force-dynamic";

export default async function ToolsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  const allowed =
    canViewSuppliers(profile) ||
    canViewCompetitors(profile) ||
    canViewEngineering(profile) ||
    isAdmin(profile);
  if (!allowed) redirect("/");

  return (
    <>
      <div
        style={{
          padding: "20px 28px 0",
          maxWidth: 1280,
          margin: "0 auto",
          width: "100%",
        }}
      >
        <ToolsTabs />
      </div>
      {children}
    </>
  );
}

import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewEngineering } from "@/lib/permissions";

export const metadata = {
  title: "Engineering Handbook — Lightbase",
};

export default async function EngineeringPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewEngineering(profile)) redirect("/");

  return (
    <iframe
      src="/engineering-handbook.html"
      title="Lightbase Engineering Handbook"
      className="flex-1 w-full border-0 bg-white"
      style={{ height: "calc(100vh - 57px)" }}
    />
  );
}

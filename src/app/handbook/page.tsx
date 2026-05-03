import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewHandbook } from "@/lib/permissions";

export const metadata = {
  title: "Handbook — Lightbase",
};

export default async function HandbookPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewHandbook(profile)) redirect("/");

  return (
    <iframe
      src="/handbook.html"
      title="Lightbase Process Handbook"
      className="flex-1 w-full border-0 bg-white"
      style={{ height: "calc(100vh - 57px)" }}
    />
  );
}

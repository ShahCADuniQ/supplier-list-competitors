import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewEngineering } from "@/lib/permissions";

export const metadata = {
  title: "Engineering Handbook — Lightbase",
};

export default async function EngineeringPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewEngineering(profile)) redirect("/");

  // External iframe content (public/engineering-handbook.html) wrapped in a
  // rounded card to fit the dark SaaS shell.
  return (
    <div className="px-6 py-6 h-full" style={{ background: "var(--lb-bg)" }}>
      <div
        className="lb-card overflow-hidden h-full"
        style={{ borderRadius: "var(--lb-radius-lg)" }}
      >
        <iframe
          src="/engineering-handbook.html"
          title="Lightbase Engineering Handbook"
          className="w-full h-full border-0"
          style={{ background: "#ffffff" }}
        />
      </div>
    </div>
  );
}

import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewHandbook } from "@/lib/permissions";

export const metadata = {
  title: "Handbook — Lightbase",
};

export default async function HandbookPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewHandbook(profile)) redirect("/");

  // The iframe content is owned separately (public/handbook.html) and uses
  // its own light styling. We wrap it in a rounded card so it sits naturally
  // inside the dark SaaS shell without bleeding to the edges.
  return (
    <div className="px-6 py-6 h-full" style={{ background: "var(--lb-bg)" }}>
      <div
        className="lb-card overflow-hidden h-full"
        style={{ borderRadius: "var(--lb-radius-lg)" }}
      >
        <iframe
          src="/handbook.html"
          title="Lightbase Process Handbook"
          className="w-full h-full border-0"
          style={{ background: "#ffffff" }}
        />
      </div>
    </div>
  );
}

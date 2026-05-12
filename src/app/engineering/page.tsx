import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewEngineering } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import ThemedIframe from "@/components/ThemedIframe";

export const metadata = {
  title: `Engineering Handbook — ${CLIENT_CONFIG.name}`,
};

export default async function EngineeringPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewEngineering(profile)) redirect("/");

  // Iframe content lives in public/engineering-handbook.html and renders its
  // own theme using --lb-* tokens mirrored into local CSS variables.
  return (
    <div className="px-6 py-6 h-full" style={{ background: "var(--lb-bg)" }}>
      <div
        className="lb-card overflow-hidden h-full"
        style={{ borderRadius: "var(--lb-radius-lg)" }}
      >
        <ThemedIframe
          src="/engineering-handbook.html"
          title={`${CLIENT_CONFIG.name} Engineering Handbook`}
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
}

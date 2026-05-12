import { redirect } from "next/navigation";
import { getOrCreateProfile, canViewHandbook } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import ThemedIframe from "@/components/ThemedIframe";

export const metadata = {
  title: `Handbook — ${CLIENT_CONFIG.name}`,
};

export default async function HandbookPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewHandbook(profile)) redirect("/");

  // Iframe content lives in public/handbook.html and renders its own theme
  // (light + dark) using --lb-* tokens mirrored into local CSS variables.
  // ThemedIframe pipes the parent app's theme into it via query param +
  // postMessage so the embedded handbook follows the global preference.
  return (
    <div className="px-6 py-6 h-full" style={{ background: "var(--lb-bg)" }}>
      <div
        className="lb-card overflow-hidden h-full"
        style={{ borderRadius: "var(--lb-radius-lg)" }}
      >
        <ThemedIframe
          src="/handbook.html"
          title={`${CLIENT_CONFIG.name} Process Handbook`}
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
}

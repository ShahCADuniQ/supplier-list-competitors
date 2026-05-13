import { redirect } from "next/navigation";
import { getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";

export const dynamic = "force-dynamic";

export const metadata = {
  title: `Design & Engineering — ${CLIENT_CONFIG.name}`,
};

// Placeholder for the future Design & Engineering surface. The Competitors,
// Process, and Engineering routes used to live under this group; they've
// been reclassified as Tools tabs (see SubNav.tsx). This page stays in the
// sidebar as a top-level destination so future Design & Engineering
// modules have a place to land. Empty for now per user request.
export default async function DesignEngineeringPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");

  return (
    <section
      className="flex flex-1 items-center justify-center px-6 py-24 min-h-full"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <div className="max-w-xl text-center">
        <span
          className="lb-section-title"
          style={{
            display: "inline-block",
            padding: "6px 16px",
            borderRadius: "var(--lb-radius-pill)",
            background: "color-mix(in srgb, var(--lb-accent) 14%, transparent)",
            color: "var(--lb-accent)",
            fontSize: 12,
          }}
        >
          Coming soon
        </span>
        <h1
          className="mt-5"
          style={{
            fontFamily: "var(--lb-font-display)",
            fontSize: "clamp(32px, 4vw, 48px)",
            lineHeight: 1.1,
            letterSpacing: "-0.025em",
            fontWeight: 700,
            color: "var(--lb-text)",
            margin: 0,
          }}
        >
          Design &amp; Engineering
        </h1>
        <p
          className="mx-auto mt-4"
          style={{
            maxWidth: 540,
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--lb-text-2)",
          }}
        >
          New surface — content lands here as Design &amp; Engineering modules
          ship. The existing Competitors, Process, and Engineering handbooks
          have moved under the Tools section.
        </p>
      </div>
    </section>
  );
}

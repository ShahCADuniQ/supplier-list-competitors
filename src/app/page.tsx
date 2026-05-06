import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canViewCompetitors,
  isAdmin,
} from "@/lib/permissions";

export default async function Home() {
  const profile = await getOrCreateProfile();

  if (!profile) {
    return (
      <section className="flex flex-1 items-center justify-center px-6 py-24">
        <div className="max-w-2xl text-center">
          <h1
            className="font-semibold tracking-tight"
            style={{
              fontFamily: "var(--lb-font-display)",
              fontSize: "clamp(40px, 6vw, 72px)",
              lineHeight: 1.05,
              letterSpacing: "-.03em",
              background:
                "linear-gradient(180deg, var(--lb-text) 0%, color-mix(in srgb, var(--lb-text) 70%, transparent) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Lightbase.
            <br />
            Operations, refined.
          </h1>
          <p
            className="mt-5 mx-auto max-w-xl"
            style={{
              fontSize: "clamp(16px, 1.5vw, 19px)",
              lineHeight: 1.5,
              color: "var(--lb-text-2)",
              letterSpacing: "-.005em",
            }}
          >
            Sign in to continue. New accounts require admin approval before
            you can view suppliers, projects, or market research.
          </p>
        </div>
      </section>
    );
  }

  const sup = canViewSuppliers(profile);
  const comp = canViewCompetitors(profile);

  if (sup && !comp) redirect("/suppliers");
  if (!sup && comp) redirect("/competitors");
  if (sup && comp) redirect("/suppliers");

  if (isAdmin(profile)) redirect("/admin");

  return (
    <section className="flex flex-1 items-center justify-center px-6 py-24">
      <div
        className="lb-card max-w-xl w-full text-center px-10 py-12"
        style={{ boxShadow: "var(--lb-shadow)" }}
      >
        <div
          className="inline-flex w-14 h-14 items-center justify-center rounded-full mb-6 text-2xl"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--lb-accent) 16%, transparent), color-mix(in srgb, var(--lb-accent) 4%, transparent))",
            color: "var(--lb-accent)",
          }}
        >
          ⏳
        </div>
        <h1
          className="font-semibold tracking-tight mb-3"
          style={{
            fontFamily: "var(--lb-font-display)",
            fontSize: "32px",
            letterSpacing: "-.022em",
          }}
        >
          Awaiting access
        </h1>
        <p
          className="mx-auto max-w-md mb-6"
          style={{ color: "var(--lb-text-2)", fontSize: "15px", lineHeight: 1.55 }}
        >
          Your account is signed in but doesn&apos;t have access to anything yet.
          An administrator (
          <span style={{ color: "var(--lb-text)", fontWeight: 500 }}>
            hshah@lightbase.ca
          </span>
          ) needs to grant you access to the supplier list, competitor tracker,
          or both.
        </p>
        <p style={{ color: "var(--lb-text-3)", fontSize: "13px" }}>
          Once approved this page will redirect automatically. You can{" "}
          <Link href="/" style={{ color: "var(--lb-accent)" }}>
            refresh
          </Link>{" "}
          at any time.
        </p>
      </div>
    </section>
  );
}

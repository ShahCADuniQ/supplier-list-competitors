import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { canViewDesignEngineering, getOrCreateProfile } from "@/lib/permissions";
import { CLIENT_CONFIG } from "@/lib/client-config";
import { getDesignProject } from "../../actions";
import ProjectWizard from "./ProjectWizard";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getDesignProject(Number(id));
  return {
    title: project
      ? `${project.name} — ${CLIENT_CONFIG.name}`
      : `Project — ${CLIENT_CONFIG.name}`,
  };
}

export default async function ProjectWizardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!canViewDesignEngineering(profile)) redirect("/");
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) notFound();
  const project = await getDesignProject(projectId);
  if (!project) notFound();

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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
        }}
      >
        <Link
          href="/design-engineering"
          style={{
            color: "var(--lb-text-3)",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          ← All projects
        </Link>
      </div>
      <ProjectWizard project={project} />
    </div>
  );
}

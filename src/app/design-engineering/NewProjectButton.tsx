"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createDesignProject } from "./actions";

export default function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setNiche("");
    setDescription("");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }
    setError(null);
    setBusy(async () => {
      try {
        const r = await createDesignProject({
          name: name.trim(),
          niche: niche.trim() || undefined,
          description: description.trim() || undefined,
        });
        reset();
        setOpen(false);
        router.push(`/design-engineering/projects/${r.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create project");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 18px",
          borderRadius: 999,
          background: "var(--lb-accent)",
          color: "var(--lb-accent-fg)",
          fontSize: 13.5,
          fontWeight: 700,
          letterSpacing: "-0.005em",
          border: "1px solid var(--lb-accent)",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        + New project
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="New project"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 60,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <form
            onSubmit={handleSubmit}
            style={{
              width: "100%",
              maxWidth: 460,
              padding: 24,
              borderRadius: 14,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              color: "var(--lb-text)",
            }}
          >
            <h2
              style={{
                fontSize: 18,
                fontWeight: 700,
                margin: 0,
                letterSpacing: "-0.01em",
              }}
            >
              Start a new design project
            </h2>
            <p
              style={{
                fontSize: 13,
                color: "var(--lb-text-2)",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              A project is one CADuniQ workflow run. Give it a name and start
              uploading CAD on the next screen.
            </p>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--lb-text-2)",
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                }}
              >
                Project name *
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Drone Frame Assembly v2"
                autoFocus
                disabled={busy}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--lb-border)",
                  background: "var(--lb-bg-elev)",
                  color: "var(--lb-text)",
                  fontSize: 14,
                }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--lb-text-2)",
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                }}
              >
                Niche (optional)
              </span>
              <input
                type="text"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                placeholder="e.g. Indoor Linear Lighting"
                disabled={busy}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--lb-border)",
                  background: "var(--lb-bg-elev)",
                  color: "var(--lb-text)",
                  fontSize: 14,
                }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--lb-text-2)",
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                }}
              >
                Description (optional)
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="1-2 sentences about what this project is for. Used as context for AI material/process recommendations."
                disabled={busy}
                rows={3}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--lb-border)",
                  background: "var(--lb-bg-elev)",
                  color: "var(--lb-text)",
                  fontSize: 14,
                  fontFamily: "inherit",
                  resize: "vertical",
                }}
              />
            </label>

            {error && (
              <div
                role="alert"
                style={{
                  fontSize: 12.5,
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: "rgba(239,68,68,0.14)",
                  color: "rgb(220,38,38)",
                  border: "1px solid rgba(239,68,68,0.28)",
                }}
              >
                {error}
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 4,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  if (!busy) {
                    reset();
                    setOpen(false);
                  }
                }}
                disabled={busy}
                style={{
                  padding: "9px 16px",
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--lb-text-2)",
                  border: "1px solid var(--lb-border)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                style={{
                  padding: "9px 18px",
                  borderRadius: 8,
                  background: "var(--lb-accent)",
                  color: "var(--lb-accent-fg)",
                  border: "1px solid var(--lb-accent)",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {busy ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

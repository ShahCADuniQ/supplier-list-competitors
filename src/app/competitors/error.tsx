"use client";

// Route-level error boundary for /competitors. Without this file the
// only thing the user sees when a Server Component (page.tsx, or any
// nested RSC) throws is React's stripped production message:
//   "An error occurred in the Server Components render. The specific
//    message is omitted in production builds…"
// This boundary surfaces the `digest` (correlates with Vercel function
// logs) and gives the user a Retry button so a transient failure
// (DB blip, Clerk session race) is one click away from recovery.

import { useEffect } from "react";

export default function CompetitorsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[competitors] route error:", error);
  }, [error]);

  return (
    <div
      style={{
        maxWidth: 720,
        margin: "64px auto",
        padding: 24,
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        color: "#e6e8ec",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>
        Couldn&apos;t load Competitors
      </h1>
      <p style={{ opacity: 0.85, lineHeight: 1.5, marginBottom: 16 }}>
        A server-side render failed. The exact message is hidden in production
        builds — copy the digest below and look it up in Vercel → your project →
        Logs (filter by digest) to see the real error.
      </p>

      <div
        style={{
          background: "rgba(255, 99, 99, 0.08)",
          border: "1px solid rgba(255, 99, 99, 0.35)",
          borderRadius: 8,
          padding: 14,
          marginBottom: 16,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 13,
          wordBreak: "break-all",
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <strong>digest:</strong>{" "}
          <code>{error.digest ?? "(none — running locally?)"}</code>
        </div>
        <div>
          <strong>message:</strong>{" "}
          <code>{error.message || "(empty)"}</code>
        </div>
      </div>

      <button
        type="button"
        onClick={() => reset()}
        style={{
          background: "#3b82f6",
          color: "white",
          border: "none",
          borderRadius: 6,
          padding: "10px 18px",
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  );
}

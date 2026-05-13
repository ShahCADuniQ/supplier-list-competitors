"use client";

// Shared progress UX for streaming server actions in the competitors area.
// Built once for the Add-Product flow; reused by Extract-Documents and any
// future streaming AI action. Honours the AI Project Master Guide §5.1
// requirements: percent bar tied to real work units, elapsed + ETA,
// concrete current-step label, heartbeat dot, cancel button.

export function formatDuration(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "—";
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

export function Heartbeat() {
  return (
    <>
      <style>{`
        @keyframes lb-progress-heartbeat {
          0%, 100% { opacity: 0.35; transform: scale(0.9); }
          50%      { opacity: 1;    transform: scale(1.15); }
        }
      `}</style>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: "var(--lb-accent, #2563eb)",
          display: "inline-block",
          animation: "lb-progress-heartbeat 1.1s ease-in-out infinite",
        }}
      />
    </>
  );
}

export function ProgressPanel(props: {
  percent: number;
  stepLabel: string;
  detail: string | null;
  elapsedSec: number;
  etaSec: number | null;
  busy: boolean;
  onCancel: () => void;
}) {
  const { percent, stepLabel, detail, elapsedSec, etaSec, busy, onCancel } =
    props;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        marginTop: 12,
        padding: "12px 14px",
        borderRadius: 10,
        background: "var(--lb-bg-elev, rgba(255,255,255,0.04))",
        border: "1px solid var(--lb-border, rgba(255,255,255,0.08))",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--lb-text, inherit)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {busy && <Heartbeat />}
          <span>{stepLabel || "Working…"}</span>
        </span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {percent.toFixed(0)}%
        </span>
      </div>

      <div
        aria-hidden
        style={{
          position: "relative",
          height: 8,
          borderRadius: 999,
          background: "rgba(255,255,255,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${percent}%`,
            background:
              "linear-gradient(90deg, var(--lb-accent, #2563eb), var(--lb-accent-2, #f97316))",
            transition: "width 360ms ease-out",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          color: "var(--lb-text-2, rgba(255,255,255,0.66))",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, marginRight: 12 }}>
          {detail ?? " "}
        </span>
        <span
          style={{
            display: "flex",
            gap: 12,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          <span>Elapsed {formatDuration(elapsedSec)}</span>
          <span>
            {etaSec !== null
              ? `ETA ${formatDuration(etaSec)}`
              : percent >= 100
                ? "Done"
                : "ETA —"}
          </span>
          {busy && (
            <button
              type="button"
              onClick={onCancel}
              className="btn ghost xs"
              style={{ padding: "0 8px", fontSize: 11 }}
              aria-label="Cancel"
            >
              Cancel
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

// Generic SSE event envelope shared between every streaming endpoint.
// Specific endpoints add their own narrow `done` payload via the generic.
export type StreamProgressEvent = {
  step: string;
  detail?: string;
  percent: number;
};

export type StreamEvent<TDone> =
  | ({ type: "progress" } & StreamProgressEvent)
  | { type: "done"; result: TDone }
  | { type: "error"; message: string };

/**
 * Read an SSE stream from a fetch Response.body and dispatch each parsed
 * envelope to the provided callbacks. Returns when the stream closes (or
 * throws if the underlying fetch aborts/errors).
 */
export async function consumeSseStream<TDone>(
  res: Response,
  callbacks: {
    onProgress: (e: StreamProgressEvent) => void;
    onDone: (result: TDone) => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  if (!res.body) {
    throw new Error("Response has no body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  loop: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue; // heartbeat or comment
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue;
      }
      const evt = parsed as StreamEvent<TDone>;
      if (evt.type === "progress") {
        callbacks.onProgress(evt);
      } else if (evt.type === "done") {
        callbacks.onDone(evt.result);
        break loop;
      } else if (evt.type === "error") {
        callbacks.onError(evt.message);
        break loop;
      }
    }
  }
}

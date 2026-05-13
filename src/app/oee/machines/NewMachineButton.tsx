"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMachine } from "../actions";

export default function NewMachineButton() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [line, setLine] = useState("");
  const [location, setLocation] = useState("");
  const [idealCycleSeconds, setIdealCycleSeconds] = useState("60");

  function reset() {
    setName("");
    setCode("");
    setLine("");
    setLocation("");
    setIdealCycleSeconds("60");
    setErr(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    startTransition(async () => {
      try {
        const ics = Number(idealCycleSeconds);
        const { id } = await createMachine({
          name,
          code: code || undefined,
          line: line || undefined,
          location: location || undefined,
          idealCycleSeconds: Number.isFinite(ics) && ics > 0 ? ics : 60,
        });
        reset();
        setOpen(false);
        router.push(`/oee/machines/${id}`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Create failed");
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          padding: "8px 14px",
          borderRadius: 999,
          background: "var(--lb-accent)",
          color: "var(--lb-accent-fg)",
          border: "1px solid var(--lb-accent)",
          fontSize: 12.5,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        + New machine
      </button>
      {open && (
        <div
          onClick={() => !busy && setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 80,
            padding: 16,
          }}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
            style={{
              background: "var(--lb-bg-elev)",
              border: "1px solid var(--lb-border)",
              borderRadius: 14,
              padding: 20,
              width: "100%",
              maxWidth: 480,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              color: "var(--lb-text)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              New machine
            </h2>
            <Field label="Name" required>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CNC Mill #3"
                required
                style={inputStyle}
              />
            </Field>
            <div style={{ display: "flex", gap: 8 }}>
              <Field label="Code">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="CNC-03"
                  style={inputStyle}
                />
              </Field>
              <Field label="Line">
                <input
                  value={line}
                  onChange={(e) => setLine(e.target.value)}
                  placeholder="Line A"
                  style={inputStyle}
                />
              </Field>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Field label="Location">
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Bay 1"
                  style={inputStyle}
                />
              </Field>
              <Field label="Ideal cycle (sec/part)">
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={idealCycleSeconds}
                  onChange={(e) => setIdealCycleSeconds(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>
            {err && (
              <div
                style={{
                  fontSize: 12,
                  color: "#ef4444",
                  padding: 8,
                  borderRadius: 8,
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                }}
              >
                {err}
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
                onClick={() => !busy && setOpen(false)}
                disabled={busy}
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "transparent",
                  color: "var(--lb-text-2)",
                  border: "1px solid var(--lb-border)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: "var(--lb-accent)",
                  color: "var(--lb-accent-fg)",
                  border: "1px solid var(--lb-accent)",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: busy ? "wait" : "pointer",
                  opacity: busy || !name.trim() ? 0.6 : 1,
                }}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--lb-bg)",
  border: "1px solid var(--lb-border)",
  color: "var(--lb-text)",
  fontSize: 13,
};

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        flex: 1,
        fontSize: 12,
        color: "var(--lb-text-2)",
      }}
    >
      <span style={{ fontWeight: 600 }}>
        {label} {required && <span style={{ color: "#ef4444" }}>*</span>}
      </span>
      {children}
    </label>
  );
}

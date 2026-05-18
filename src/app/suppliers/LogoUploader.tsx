"use client";

// Generic logo uploader. Used by the supplier portal (vendor logo) and the
// admin client-settings panel (buyer / client logo). Uploads through Vercel
// Blob's client SDK so the file lands directly in storage; then calls the
// matching server action to attach it to the row.

import { useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import {
  clearClientLogo,
  clearSupplierLogo,
  setClientLogo,
  setSupplierLogo,
} from "@/app/suppliers/rfq-actions";

function safeFile(name: string): string {
  return (name || "file").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "file";
}

type CommonProps = {
  // Current logo URL + filename so the existing image shows up beside the
  // "Replace" button. Null = no logo uploaded yet.
  currentUrl: string | null;
  currentName?: string | null;
  // Plain-text label shown above the upload control.
  label: string;
  hint?: string;
};

export function SupplierLogoUploader({
  supplierId,
  currentUrl,
  currentName,
  label,
  hint,
}: CommonProps & { supplierId: number }) {
  return (
    <LogoUploaderBase
      currentUrl={currentUrl}
      currentName={currentName}
      label={label}
      hint={hint}
      uploadPath={(name) => `suppliers/${supplierId}/logo/${crypto.randomUUID()}-${safeFile(name)}`}
      onUploaded={(input) =>
        setSupplierLogo({
          supplierId,
          url: input.url,
          name: input.name,
          blobPathname: input.blobPathname,
        })
      }
      onCleared={() => clearSupplierLogo(supplierId)}
    />
  );
}

export function ClientLogoUploader({
  clientId,
  currentUrl,
  currentName,
  label,
  hint,
}: CommonProps & { clientId: number }) {
  return (
    <LogoUploaderBase
      currentUrl={currentUrl}
      currentName={currentName}
      label={label}
      hint={hint}
      uploadPath={(name) => `clients/${clientId}/logo/${crypto.randomUUID()}-${safeFile(name)}`}
      onUploaded={(input) =>
        setClientLogo({
          clientId,
          url: input.url,
          name: input.name,
          blobPathname: input.blobPathname,
        })
      }
      onCleared={() => clearClientLogo(clientId)}
    />
  );
}

function LogoUploaderBase({
  currentUrl,
  currentName,
  label,
  hint,
  uploadPath,
  onUploaded,
  onCleared,
}: CommonProps & {
  uploadPath: (name: string) => string;
  onUploaded: (input: { url: string; name: string; blobPathname: string }) => Promise<unknown>;
  onCleared: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const blob = await upload(uploadPath(file.name), file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: file.type || undefined,
      });
      startTransition(async () => {
        try {
          await onUploaded({ url: blob.url, name: file.name, blobPathname: blob.pathname });
          window.location.reload();
        } catch (e) {
          setErr(e instanceof Error ? e.message : "Save failed");
          setBusy(false);
        }
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
      setBusy(false);
    }
  }

  function handleClear() {
    if (!confirm("Remove the current logo?")) return;
    setBusy(true);
    startTransition(async () => {
      try {
        await onCleared();
        window.location.reload();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Remove failed");
        setBusy(false);
      }
    });
  }

  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        display: "flex",
        gap: 14,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <div style={{ width: 80, height: 80, borderRadius: 6, background: "var(--lb-bg)", border: "1px solid var(--lb-border)", display: "grid", placeItems: "center", overflow: "hidden" }}>
        {currentUrl ? (
          <img src={currentUrl} alt={currentName ?? "Logo"} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        ) : (
          <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>No logo</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--lb-text)" }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "var(--lb-text-3)", marginTop: 2 }}>{hint}</div>}
        {currentName && <div style={{ fontSize: 11, color: "var(--lb-text-3)", marginTop: 4 }}>{currentName}</div>}
        {err && <div style={{ fontSize: 11.5, color: "#dc2626", marginTop: 4 }}>{err}</div>}
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <label
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              background: "var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              border: "1px solid var(--lb-accent)",
              fontSize: 12,
              fontWeight: 700,
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Saving…" : currentUrl ? "↺ Replace logo" : "📤 Upload logo"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              style={{ display: "none" }}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) handleFile(f);
              }}
            />
          </label>
          {currentUrl && (
            <button
              type="button"
              onClick={handleClear}
              disabled={busy}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                background: "transparent",
                color: "#dc2626",
                border: "1px solid #dc262666",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ✕ Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

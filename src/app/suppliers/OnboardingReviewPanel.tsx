"use client";

// Admin-only panel listing every supplier whose onboarding submission
// is waiting for review. Each row gets View report / Approve / Reject
// buttons. The "View report" drawer surfaces every field the supplier
// answered including the full checklist Y/N/NA grid.

import { useEffect, useState } from "react";
import {
  approveSupplierByMerging,
  approveSupplierOnboarding,
  getSupplierOnboardingState,
  listPendingOnboardingSuppliers,
  listPotentialSupplierMatches,
  rejectSupplierOnboarding,
  searchSupplierDirectoryForMerge,
  type PendingSupplier,
  type SupplierDirectoryRow,
  type SupplierMatchCandidate,
  type SupplierOnboardingState,
} from "./onboarding-actions";

export default function OnboardingReviewPanel({ canEdit }: { canEdit: boolean }) {
  const [pending, setPending] = useState<PendingSupplier[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [openReportId, setOpenReportId] = useState<number | null>(null);
  // Per-pending-row potential matches against the same tenant's existing
  // supplier directory. Loaded lazily on first render of each row so the
  // queue itself stays snappy when there's nothing to match against.
  const [matchesByPending, setMatchesByPending] = useState<
    Record<number, SupplierMatchCandidate[] | null>
  >({});
  // Open picker drawer for "approve & link to a different supplier".
  const [pickerForId, setPickerForId] = useState<number | null>(null);

  function reload() {
    listPendingOnboardingSuppliers()
      .then((rows) => {
        setPending(rows);
        // Kick off potential-match lookups for every row in parallel.
        for (const r of rows) {
          listPotentialSupplierMatches({ supplierId: r.id })
            .then((m) =>
              setMatchesByPending((prev) => ({ ...prev, [r.id]: m })),
            )
            .catch(() =>
              setMatchesByPending((prev) => ({ ...prev, [r.id]: [] })),
            );
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }
  useEffect(() => {
    if (pending === null) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function approve(id: number) {
    if (!canEdit) return;
    setBusyId(id); setErr(null);
    try {
      await approveSupplierOnboarding({ supplierId: id });
      reload();
      if (openReportId === id) setOpenReportId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Approve failed");
    } finally { setBusyId(null); }
  }

  async function approveAndMerge(pendingId: number, targetId: number) {
    if (!canEdit) return;
    setBusyId(pendingId); setErr(null);
    try {
      await approveSupplierByMerging({
        pendingSupplierId: pendingId,
        targetSupplierId: targetId,
      });
      reload();
      if (openReportId === pendingId) setOpenReportId(null);
      if (pickerForId === pendingId) setPickerForId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Merge failed");
    } finally { setBusyId(null); }
  }
  async function reject(id: number) {
    if (!canEdit) return;
    const notes = prompt("Tell the supplier what they need to fix. They'll see this when they resubmit:");
    if (!notes || !notes.trim()) return;
    setBusyId(id); setErr(null);
    try {
      await rejectSupplierOnboarding({ supplierId: id, notes });
      reload();
      if (openReportId === id) setOpenReportId(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reject failed");
    } finally { setBusyId(null); }
  }

  const openRow = openReportId != null
    ? (pending ?? []).find((p) => p.id === openReportId) ?? null
    : null;

  return (
    <div>
      <header style={{
        padding: 14,
        marginBottom: 14,
        borderRadius: 12,
        background: "linear-gradient(135deg, rgba(234,88,12,0.10), rgba(8,145,178,0.06))",
        border: "1px solid var(--lb-border)",
      }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--lb-accent)" }}>
          Onboarding requests
        </div>
        <h3 style={{ fontSize: 17, fontWeight: 800, margin: "4px 0 0", color: "var(--lb-text)" }}>
          {pending === null
            ? "Loading…"
            : pending.length === 0
              ? "No submissions waiting"
              : `${pending.length} supplier${pending.length === 1 ? "" : "s"} waiting for your approval`}
        </h3>
        <p style={{ fontSize: 12.5, color: "var(--lb-text-3)", marginTop: 4 }}>
          Suppliers who&apos;ve completed the onboarding checklist appear here. Approve to unlock their portal (Catalogue, Order Requests, Chat) — Reject to send them back with feedback.
        </p>
      </header>

      {err && (
        <div style={{ marginBottom: 12, padding: 10, background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 8, color: "#dc2626", fontSize: 13 }}>
          {err}
        </div>
      )}

      {pending && pending.length === 0 && (
        <div style={{
          padding: 32,
          textAlign: "center",
          color: "var(--lb-text-3)",
          fontSize: 13,
          border: "1px dashed var(--lb-border)",
          borderRadius: 10,
        }}>
          The queue is empty. New supplier submissions will appear here automatically.
        </div>
      )}

      {pending && pending.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pending.map((p) => {
            const verdictColor =
              p.verdict === "pre-qualified" ? "#16a34a" :
              p.verdict === "conditional"  ? "#ca8a04" :
              p.verdict === "not-qualified" ? "#dc2626" : "var(--lb-text-3)";
            const matches = matchesByPending[p.id];
            const matchesLoading = matches === undefined;
            const topMatch = matches && matches.length > 0 ? matches[0] : null;
            return (
              <div key={p.id} style={{
                padding: 14,
                background: "var(--lb-bg-elev)",
                border: "1px solid var(--lb-border)",
                borderLeft: topMatch ? "4px solid #ca8a04" : "1px solid var(--lb-border)",
                borderRadius: 10,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontWeight: 700, fontSize: 14.5, color: "var(--lb-text)" }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 2 }}>
                      {p.contactName ?? "—"}{p.email ? ` · ${p.email}` : ""}
                      {p.category ? ` · ${p.category}` : ""}
                      {p.origin ? ` · ${p.origin}` : ""}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--lb-text-3)", marginTop: 3 }}>
                      Submitted {p.submittedAt ? new Date(p.submittedAt).toLocaleString() : "—"}
                    </div>
                  </div>
                  {p.verdict && (
                    <div style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: `1px solid ${verdictColor}`,
                      color: verdictColor,
                      fontSize: 11.5,
                      fontWeight: 700,
                      letterSpacing: 0.4,
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                    }}>
                      {p.verdict.replace("-", " ")} {p.score != null && p.scoreMax != null ? `· ${p.score}/${p.scoreMax}` : ""}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => setOpenReportId(p.id)}
                      style={{
                        padding: "6px 14px",
                        fontSize: 12.5,
                        fontWeight: 600,
                        borderRadius: 999,
                        background: "var(--lb-bg)",
                        color: "var(--lb-text)",
                        border: "1px solid var(--lb-border)",
                        cursor: "pointer",
                      }}
                    >
                      View report
                    </button>
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => approve(p.id)}
                          disabled={busyId === p.id}
                          title={topMatch ? "Approve as a NEW supplier, ignoring the suggested match." : undefined}
                          style={{
                            padding: "6px 14px",
                            fontSize: 12.5,
                            fontWeight: 700,
                            borderRadius: 999,
                            background: topMatch ? "var(--lb-bg)" : "#16a34a",
                            color: topMatch ? "var(--lb-text)" : "#fff",
                            border: topMatch ? "1px solid var(--lb-border)" : "1px solid #16a34a",
                            cursor: busyId === p.id ? "wait" : "pointer",
                            opacity: busyId === p.id ? 0.6 : 1,
                          }}
                        >
                          {topMatch ? "✓ Approve as new" : "✓ Approve"}
                        </button>
                        <button
                          type="button"
                          onClick={() => reject(p.id)}
                          disabled={busyId === p.id}
                          style={{
                            padding: "6px 14px",
                            fontSize: 12.5,
                            fontWeight: 700,
                            borderRadius: 999,
                            background: "transparent",
                            color: "#dc2626",
                            border: "1px solid #dc2626",
                            cursor: busyId === p.id ? "wait" : "pointer",
                            opacity: busyId === p.id ? 0.6 : 1,
                          }}
                        >
                          ✕ Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Potential-duplicate banner. Shown when fuzzy matching
                    flagged at least one existing supplier on the same
                    tenant. The reviewer can approve-and-merge into the
                    top suggestion, expand to see the other candidates,
                    or open a picker to link to ANY supplier in the
                    directory. */}
                {matchesLoading && (
                  <div style={{
                    fontSize: 11.5,
                    color: "var(--lb-text-3)",
                    fontStyle: "italic",
                  }}>
                    Checking your directory for potential duplicates…
                  </div>
                )}
                {matches && matches.length > 0 && (
                  <PotentialMatchBlock
                    matches={matches}
                    canEdit={canEdit}
                    busy={busyId === p.id}
                    onMerge={(targetId) => approveAndMerge(p.id, targetId)}
                    onOpenPicker={() => setPickerForId(p.id)}
                  />
                )}
                {matches && matches.length === 0 && canEdit && (
                  <div style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                    fontSize: 11.5,
                    color: "var(--lb-text-3)",
                  }}>
                    <span>No likely duplicates found.</span>
                    <button
                      type="button"
                      onClick={() => setPickerForId(p.id)}
                      style={{
                        padding: "4px 10px",
                        fontSize: 11.5,
                        fontWeight: 600,
                        borderRadius: 999,
                        background: "var(--lb-bg)",
                        border: "1px solid var(--lb-border)",
                        color: "var(--lb-text-2)",
                        cursor: "pointer",
                      }}
                    >
                      Link to an existing supplier…
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pickerForId !== null && (
        <SupplierMergePicker
          pendingSupplierId={pickerForId}
          busy={busyId === pickerForId}
          onClose={() => setPickerForId(null)}
          onPick={(targetId) => approveAndMerge(pickerForId, targetId)}
        />
      )}

      {openRow && (
        <OnboardingReportDrawer
          summary={openRow}
          onClose={() => setOpenReportId(null)}
          onApprove={canEdit ? () => approve(openRow.id) : undefined}
          onReject={canEdit ? () => reject(openRow.id) : undefined}
          busy={busyId === openRow.id}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Potential-duplicate banner. Sits under each pending row and lets the
// reviewer approve-and-merge the sign-up into an existing supplier
// instead of approving as a brand-new row. The top suggestion gets a
// dedicated big button; remaining candidates collapse into a list the
// reviewer can expand. A separate "Link to a different supplier" entry
// opens the directory picker for when none of the auto-matches are
// correct.
// ─────────────────────────────────────────────────────────────────────────────

function PotentialMatchBlock({
  matches,
  canEdit,
  busy,
  onMerge,
  onOpenPicker,
}: {
  matches: SupplierMatchCandidate[];
  canEdit: boolean;
  busy: boolean;
  onMerge: (targetId: number) => void;
  onOpenPicker: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const top = matches[0];
  const rest = matches.slice(1);

  return (
    <div style={{
      borderRadius: 8,
      background: "rgba(202,138,4,0.10)",
      border: "1px solid rgba(202,138,4,0.35)",
      padding: 10,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "#ca8a04",
      }}>
        Potential duplicate in your directory
      </div>

      <MatchRow
        match={top}
        canEdit={canEdit}
        busy={busy}
        primary
        onMerge={() => onMerge(top.id)}
      />

      {rest.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              fontWeight: 700,
              borderRadius: 999,
              background: "transparent",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-2)",
              cursor: "pointer",
            }}
          >
            {expanded ? "Hide" : `Show ${rest.length} more match${rest.length === 1 ? "" : "es"}`}
          </button>
          {expanded && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              {rest.map((m) => (
                <MatchRow
                  key={m.id}
                  match={m}
                  canEdit={canEdit}
                  busy={busy}
                  onMerge={() => onMerge(m.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div>
          <button
            type="button"
            onClick={onOpenPicker}
            style={{
              padding: "4px 10px",
              fontSize: 11.5,
              fontWeight: 600,
              borderRadius: 999,
              background: "var(--lb-bg)",
              border: "1px solid var(--lb-border)",
              color: "var(--lb-text-2)",
              cursor: "pointer",
            }}
          >
            None of these — pick a different supplier from the directory…
          </button>
        </div>
      )}
    </div>
  );
}

function MatchRow({
  match,
  canEdit,
  busy,
  primary,
  onMerge,
}: {
  match: SupplierMatchCandidate;
  canEdit: boolean;
  busy: boolean;
  primary?: boolean;
  onMerge: () => void;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: primary ? 8 : "4px 8px",
      background: primary ? "var(--lb-bg)" : "transparent",
      border: primary ? "1px solid var(--lb-border)" : "none",
      borderRadius: 8,
      flexWrap: "wrap",
    }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{
          fontSize: primary ? 13.5 : 12.5,
          fontWeight: 700,
          color: "var(--lb-text)",
        }}>
          {match.name}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 2 }}>
          {match.contactName ? `${match.contactName} · ` : ""}
          {match.email ?? match.website ?? ""}
          {match.category ? ` · ${match.category}` : ""}
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
          {match.reasons.map((r) => (
            <span key={r} style={{
              padding: "2px 8px",
              fontSize: 10.5,
              fontWeight: 700,
              borderRadius: 999,
              background: "rgba(202,138,4,0.18)",
              color: "#ca8a04",
              border: "1px solid rgba(202,138,4,0.45)",
              letterSpacing: 0.3,
            }}>
              {r}
            </span>
          ))}
        </div>
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={onMerge}
          disabled={busy}
          style={{
            padding: primary ? "7px 14px" : "5px 12px",
            fontSize: primary ? 12.5 : 11.5,
            fontWeight: 700,
            borderRadius: 999,
            background: "#ca8a04",
            color: "#fff",
            border: "1px solid #ca8a04",
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
        >
          ✓ Approve & merge into this
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Picker drawer — surfaces the engineering tenant's whole approved
// supplier directory, searchable, so the reviewer can attach the sign-up
// to a supplier the auto-matcher missed.
// ─────────────────────────────────────────────────────────────────────────────

function SupplierMergePicker({
  pendingSupplierId,
  busy,
  onClose,
  onPick,
}: {
  pendingSupplierId: number;
  busy: boolean;
  onClose: () => void;
  onPick: (targetId: number) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SupplierDirectoryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      searchSupplierDirectoryForMerge({
        pendingSupplierId,
        query: q.trim() || undefined,
      })
        .then((rows) => {
          if (!cancelled) setResults(rows);
        })
        .catch((e) => {
          if (!cancelled) setErr(e instanceof Error ? e.message : "Search failed");
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [pendingSupplierId, q]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 110,
        display: "flex", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--lb-bg)",
          borderLeft: "1px solid var(--lb-border)",
          width: "100%",
          maxWidth: 560,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header style={{
          padding: "14px 18px",
          borderBottom: "1px solid var(--lb-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
              Link sign-up to existing supplier
            </div>
            <h3 style={{ fontSize: 17, fontWeight: 800, margin: "4px 0 0" }}>
              Pick the supplier in your directory
            </h3>
            <p style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 4 }}>
              We&apos;ll move attachments, contacts, and the submission onto the
              chosen supplier, then approve it. The pending sign-up row is
              removed.
            </p>
          </div>
          <button type="button" onClick={onClose} style={{
            padding: "4px 12px", fontSize: 13, borderRadius: 6, background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)", color: "var(--lb-text-2)", cursor: "pointer",
          }}>✕</button>
        </header>

        <div style={{ padding: 14, borderBottom: "1px solid var(--lb-border)" }}>
          <input
            type="search"
            placeholder="Search by name, email, or website…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 999,
              background: "var(--lb-bg-elev)",
              color: "var(--lb-text)",
              border: "1px solid var(--lb-border)",
              fontSize: 13.5,
              outline: "none",
            }}
          />
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {err && (
            <div style={{
              padding: 10,
              background: "rgba(220,38,38,0.1)",
              border: "1px solid rgba(220,38,38,0.4)",
              borderRadius: 8,
              color: "#dc2626",
              fontSize: 12.5,
              marginBottom: 10,
            }}>
              {err}
            </div>
          )}
          {results === null && (
            <div style={{ color: "var(--lb-text-3)", fontSize: 12.5 }}>Loading suppliers…</div>
          )}
          {results && results.length === 0 && (
            <div style={{
              padding: 24,
              textAlign: "center",
              border: "1px dashed var(--lb-border)",
              borderRadius: 10,
              color: "var(--lb-text-3)",
              fontSize: 12.5,
            }}>
              No matches in your directory. Approve as a new supplier on the
              queue card instead.
            </div>
          )}
          {results && results.length > 0 && (
            <ul style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}>
              {results.map((r) => (
                <li key={r.id} style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  padding: 10,
                  borderRadius: 8,
                  background: "var(--lb-bg-elev)",
                  border: "1px solid var(--lb-border)",
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--lb-text)" }}>
                      {r.name}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 2 }}>
                      {r.contactName ? `${r.contactName} · ` : ""}
                      {r.email ?? r.website ?? ""}
                      {r.category ? ` · ${r.category}` : ""}
                      {r.origin ? ` · ${r.origin}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onPick(r.id)}
                    disabled={busy}
                    style={{
                      padding: "6px 14px",
                      fontSize: 12.5,
                      fontWeight: 700,
                      borderRadius: 999,
                      background: "var(--lb-accent)",
                      color: "var(--lb-accent-fg)",
                      border: "1px solid var(--lb-accent)",
                      cursor: busy ? "wait" : "pointer",
                      opacity: busy ? 0.6 : 1,
                      whiteSpace: "nowrap",
                    }}
                  >
                    Merge here
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail drawer — fetches the full submission for one supplier and renders
// every field they filled in plus the Y/N/NA checklist grid.
// ─────────────────────────────────────────────────────────────────────────────

type FormData = {
  companyName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  website?: string;
  category?: string;
  subCategory?: string;
  origin?: string;
  products?: string;
  manufacturingTypes?: string[];
  materials?: string[];
  countryCode?: string;
  countryTier?: string;
  answers?: Record<string, "yes" | "no" | "na">;
  notes?: string;
};

function OnboardingReportDrawer({
  summary,
  onClose,
  onApprove,
  onReject,
  busy,
}: {
  summary: PendingSupplier;
  onClose: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  busy: boolean;
}) {
  const [state, setState] = useState<SupplierOnboardingState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getSupplierOnboardingState({ supplierId: summary.id })
      .then(setState)
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
  }, [summary.id]);

  const fd = (state?.latestSubmission?.formData ?? {}) as FormData;
  const verdictColor =
    state?.latestSubmission?.verdict === "pre-qualified" ? "#16a34a" :
    state?.latestSubmission?.verdict === "conditional"  ? "#ca8a04" :
    state?.latestSubmission?.verdict === "not-qualified" ? "#dc2626" : "var(--lb-text-3)";

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100,
        display: "flex", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--lb-bg)",
          borderLeft: "1px solid var(--lb-border)",
          width: "100%",
          maxWidth: 720,
          boxShadow: "-12px 0 48px rgba(0,0,0,0.4)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <header style={{
          padding: "14px 18px",
          borderBottom: "1px solid var(--lb-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          position: "sticky",
          top: 0,
          background: "var(--lb-bg)",
          zIndex: 1,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
              Onboarding report
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "4px 0 0", letterSpacing: "-0.01em" }}>
              {summary.name}
            </h3>
            <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 4 }}>
              Submitted {summary.submittedAt ? new Date(summary.submittedAt).toLocaleString() : "—"}
            </div>
          </div>
          <button type="button" onClick={onClose} style={{
            padding: "4px 12px", fontSize: 13, borderRadius: 6, background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)", color: "var(--lb-text-2)", cursor: "pointer",
          }}>✕</button>
        </header>

        {state === null && !err && (
          <div style={{ padding: 24, color: "var(--lb-text-3)", fontSize: 13 }}>Loading submission…</div>
        )}
        {err && (
          <div style={{ padding: 16, margin: 16, background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 8, color: "#dc2626", fontSize: 13 }}>
            {err}
          </div>
        )}

        {state && (
          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Verdict header */}
            <section style={{
              padding: 14,
              borderRadius: 10,
              border: `1px solid ${verdictColor}`,
              background: `${verdictColor}10`,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: verdictColor }}>
                    Self-reported verdict
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "var(--lb-text)", marginTop: 2 }}>
                    {state.latestSubmission?.verdict
                      ? state.latestSubmission.verdict.replace("-", " ")
                      : "—"}
                  </div>
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "var(--lb-text)" }}>
                  {state.latestSubmission?.score ?? "—"}
                  <span style={{ fontSize: 12, fontWeight: 500, color: "var(--lb-text-3)", marginLeft: 4 }}>
                    / {state.latestSubmission?.scoreMax ?? "—"}
                  </span>
                </div>
              </div>
            </section>

            {/* Company info */}
            <DetailSection title="Company information">
              <Row label="Legal name" value={fd.companyName ?? summary.name} />
              <Row label="Contact" value={fd.contactName} />
              <Row label="Email" value={fd.email ?? summary.email ?? null} />
              <Row label="Phone" value={fd.phone} />
              <Row label="Website" value={fd.website} link />
              <Row label="Country of manufacture" value={fd.origin} />
            </DetailSection>

            {/* What they supply */}
            <DetailSection title="What they supply">
              <Row label="Primary category" value={fd.category} />
              <Row label="Sub-category" value={fd.subCategory} />
              <Row label="Products" value={fd.products} multiline />
              <Row label="Manufacturing capabilities" chips={fd.manufacturingTypes} />
              <Row label="Materials" chips={fd.materials} />
            </DetailSection>

            {/* Checklist */}
            <DetailSection title="Compliance checklist">
              {fd.answers && Object.keys(fd.answers).length > 0 ? (
                <ChecklistGrid answers={fd.answers} />
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--lb-text-3)" }}>No checklist answers recorded.</div>
              )}
            </DetailSection>

            {fd.notes && (
              <DetailSection title="Supplier notes to reviewer">
                <div style={{
                  fontSize: 13,
                  color: "var(--lb-text-2)",
                  background: "var(--lb-bg-elev)",
                  border: "1px solid var(--lb-border)",
                  borderLeft: "3px solid var(--lb-accent)",
                  borderRadius: 4,
                  padding: 10,
                  whiteSpace: "pre-wrap",
                }}>
                  {fd.notes}
                </div>
              </DetailSection>
            )}

            {(onApprove || onReject) && (
              <section style={{
                marginTop: 6,
                padding: 14,
                borderRadius: 10,
                background: "var(--lb-bg-elev)",
                border: "1px solid var(--lb-border)",
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                flexWrap: "wrap",
                position: "sticky",
                bottom: 0,
              }}>
                {onReject && (
                  <button
                    type="button"
                    onClick={onReject}
                    disabled={busy}
                    style={{
                      padding: "8px 18px",
                      fontSize: 13,
                      fontWeight: 700,
                      borderRadius: 999,
                      background: "transparent",
                      color: "#dc2626",
                      border: "1px solid #dc2626",
                      cursor: busy ? "wait" : "pointer",
                    }}
                  >✕ Reject</button>
                )}
                {onApprove && (
                  <button
                    type="button"
                    onClick={onApprove}
                    disabled={busy}
                    style={{
                      padding: "8px 18px",
                      fontSize: 13,
                      fontWeight: 700,
                      borderRadius: 999,
                      background: "#16a34a",
                      color: "#fff",
                      border: "1px solid #16a34a",
                      cursor: busy ? "wait" : "pointer",
                    }}
                  >✓ Approve</button>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      borderRadius: 10,
      border: "1px solid var(--lb-border)",
      background: "var(--lb-bg-elev)",
      padding: 14,
    }}>
      <h4 style={{
        fontSize: 11.5, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase",
        color: "var(--lb-accent)", margin: "0 0 10px", paddingBottom: 6,
        borderBottom: "1px solid var(--lb-border)",
      }}>{title}</h4>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </section>
  );
}

function Row({ label, value, chips, multiline, link }: {
  label: string;
  value?: string | null;
  chips?: string[];
  multiline?: boolean;
  link?: boolean;
}) {
  const hasChips = Array.isArray(chips) && chips.length > 0;
  const hasValue = value && value.trim().length > 0;
  if (!hasChips && !hasValue) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, alignItems: "flex-start" }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--lb-text-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
      {hasChips ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {chips!.map((c) => (
            <span key={c} style={{
              padding: "3px 8px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 999,
              background: "rgba(8,145,178,0.12)",
              color: "#0891b2",
              border: "1px solid rgba(8,145,178,0.3)",
            }}>{c}</span>
          ))}
        </div>
      ) : link && value ? (
        <a href={value.startsWith("http") ? value : `https://${value}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "var(--lb-accent)" }}>{value}</a>
      ) : (
        <div style={{
          fontSize: 13,
          color: "var(--lb-text)",
          whiteSpace: multiline ? "pre-wrap" : "normal",
        }}>
          {value}
        </div>
      )}
    </div>
  );
}

// Reuses the same question list the form renders so the report and the
// form stay in lockstep. Keeping the texts inline (vs importing them
// from the form) avoids a circular client/server boundary issue.
const CHECKLIST_QUESTIONS: Array<{ id: string; text: string; critical: boolean }> = [
  { id: "u1", text: "ISO 9001 (or equivalent QMS)", critical: true },
  { id: "u2", text: "cUL / CSA / ETL-c certification capability", critical: true },
  { id: "u3", text: "ISED ICES-003 EMC compliance", critical: true },
  { id: "u4", text: "Bilingual EN / FR datasheets & SDS (Quebec Bill 96)", critical: true },
  { id: "u5", text: "Supply-chain disclosure (Bill S-211)", critical: true },
  { id: "u6", text: "RoHS / REACH / Health Canada CCPSA declarations", critical: true },
  { id: "u7", text: "HS codes & country-of-origin marking", critical: true },
  { id: "u8", text: "Product Liability insurance ≥ CAD 2M", critical: true },
  { id: "u9", text: "NRCan Energy Efficiency Regulations alignment", critical: false },
  { id: "u10", text: "Prior experience supplying lighting OEMs into Canada", critical: false },
];

function ChecklistGrid({ answers }: { answers: Record<string, "yes" | "no" | "na"> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {CHECKLIST_QUESTIONS.map((q) => {
        const a = answers[q.id];
        const ansColor =
          a === "yes" ? "#16a34a" :
          a === "no"  ? "#dc2626" :
          a === "na"  ? "#64748b" : "var(--lb-text-3)";
        return (
          <div key={q.id} style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 10,
            padding: "6px 0",
            borderBottom: "1px solid var(--lb-border)",
            alignItems: "center",
          }}>
            <div style={{ fontSize: 12.5, color: "var(--lb-text)" }}>
              {q.critical && <span style={{ color: "var(--lb-accent)", marginRight: 5 }}>★</span>}
              {q.text}
            </div>
            <span style={{
              padding: "2px 10px",
              borderRadius: 999,
              border: `1px solid ${ansColor}`,
              color: ansColor,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}>
              {a ?? "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

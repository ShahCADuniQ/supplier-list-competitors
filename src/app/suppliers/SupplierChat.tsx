"use client";

// Live chat between buyer (Lightbase team) and a single supplier's portal
// users. Renders a two-pane layout: channel sidebar on the left, message
// thread on the right. Buyer sees full admin controls (+ New channel,
// rename, archive); supplier sees only the channel switcher.
//
// Updates are pulled by polling — the active channel's message list
// refreshes every 4 seconds while the user has the tab focused; the
// channel sidebar refreshes every 12 seconds. Both pause when document
// visibility is hidden so a backgrounded tab doesn't burn quota.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { upload } from "@vercel/blob/client";
import type { ChatMessage } from "@/db/schema";
import {
  archiveChannel,
  createChannel,
  deleteMessage,
  listChannels,
  listMessages,
  markChannelRead,
  renameChannel,
  sendMessage,
  type ChannelWithUnread,
} from "./chat-actions";

const POLL_MESSAGES_MS = 4_000;
const POLL_CHANNELS_MS = 12_000;

function safeFile(name: string): string {
  return (name || "file").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "file";
}

export default function SupplierChat({
  supplierId,
  supplierName,
  viewerRole,
  height = 520,
}: {
  supplierId: number;
  supplierName: string;
  viewerRole: "buyer" | "supplier";
  // The pane is rendered inside another scrollable container most of the
  // time, so let callers cap the height instead of relying on flex-grow.
  height?: number;
}) {
  const [channels, setChannels] = useState<ChannelWithUnread[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const [attachment, setAttachment] = useState<{
    url: string; name: string; pathname: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  // Track the most-recent message's createdAt so the poll can ask for only
  // newer rows. ms-epoch fits the action's `sinceMs` cursor cleanly.
  const lastMsgMs = useRef<number>(0);

  // ── load channels ──
  const reloadChannels = useCallback(async () => {
    try {
      const rows = await listChannels(supplierId);
      setChannels(rows);
      if (activeId == null && rows.length > 0) setActiveId(rows[0].id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load channels");
    }
  }, [supplierId, activeId]);

  useEffect(() => {
    reloadChannels();
  }, [reloadChannels]);

  // ── load messages for the active channel ──
  const loadFull = useCallback(async (channelId: number) => {
    try {
      const rows = await listMessages({ channelId });
      setMessages(rows);
      lastMsgMs.current = rows.length > 0
        ? new Date(rows[rows.length - 1].createdAt).getTime()
        : 0;
      // Mark this channel read after a fresh load.
      await markChannelRead({ channelId });
      // Bump unread counts in the sidebar copy without re-fetching.
      setChannels((cs) => cs.map((c) => (c.id === channelId ? { ...c, unreadCount: 0 } : c)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load messages");
    }
  }, []);

  useEffect(() => {
    if (activeId == null) return;
    loadFull(activeId);
  }, [activeId, loadFull]);

  // Auto-scroll to bottom when the message list grows.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ── polling: incremental message fetch ──
  useEffect(() => {
    if (activeId == null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      if (cancelled) return;
      if (document.hidden) return;
      try {
        const newer = await listMessages({
          channelId: activeId!,
          sinceMs: lastMsgMs.current || undefined,
        });
        if (newer.length === 0) return;
        setMessages((prev) => {
          // De-dupe in case of overlapping polls.
          const seen = new Set(prev.map((m) => m.id));
          const adds = newer.filter((m) => !seen.has(m.id));
          if (adds.length === 0) return prev;
          return [...prev, ...adds];
        });
        const lastNew = newer[newer.length - 1];
        lastMsgMs.current = new Date(lastNew.createdAt).getTime();
        markChannelRead({ channelId: activeId! }).catch(() => {});
      } catch {
        // Silent — pollers shouldn't surface transient errors.
      }
    }

    timer = setInterval(poll, POLL_MESSAGES_MS);
    function onVisibility() { if (!document.hidden) poll(); }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeId]);

  // ── polling: channel sidebar (slower, for unread badges) ──
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      reloadChannels();
    }, POLL_CHANNELS_MS);
    return () => clearInterval(timer);
  }, [reloadChannels]);

  async function handleSend() {
    if (activeId == null) return;
    const body = draft.trim();
    if (!body && !attachment) return;
    setBusy(true);
    setErr(null);
    try {
      await sendMessage({
        channelId: activeId,
        body,
        attachmentUrl: attachment?.url,
        attachmentName: attachment?.name,
        attachmentPathname: attachment?.pathname,
      });
      setDraft("");
      setAttachment(null);
      // Pull only the new row(s) via the existing poll path.
      const newer = await listMessages({ channelId: activeId, sinceMs: lastMsgMs.current || undefined });
      if (newer.length > 0) {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...newer.filter((m) => !seen.has(m.id))];
        });
        lastMsgMs.current = new Date(newer[newer.length - 1].createdAt).getTime();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleAttach(file: File) {
    setUploading(true);
    setErr(null);
    try {
      const pathname = `chat/${supplierId}/${crypto.randomUUID()}-${safeFile(file.name)}`;
      const blob = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        contentType: file.type || undefined,
      });
      setAttachment({ url: blob.url, name: file.name, pathname: blob.pathname });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleDelete(msg: ChatMessage) {
    if (!confirm("Delete this message?")) return;
    startTransition(async () => {
      try {
        await deleteMessage({ messageId: msg.id });
        setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Delete failed");
      }
    });
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        gap: 0,
        height,
        borderRadius: 12,
        border: "1px solid var(--lb-border)",
        background: "var(--lb-bg-elev)",
        overflow: "hidden",
      }}
    >
      <ChannelSidebar
        supplierId={supplierId}
        supplierName={supplierName}
        viewerRole={viewerRole}
        channels={channels}
        activeId={activeId}
        onSelect={(id) => setActiveId(id)}
        onChanged={reloadChannels}
      />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        {err && (
          <div style={{ padding: "8px 12px", background: "rgba(220,38,38,0.12)", color: "#fca5a5", fontSize: 12 }}>
            {err}
          </div>
        )}
        <div
          ref={threadRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: "var(--lb-bg)",
          }}
        >
          {activeId == null ? (
            <Empty>Pick a channel on the left to start chatting.</Empty>
          ) : messages.length === 0 ? (
            <Empty>
              No messages yet. {viewerRole === "buyer"
                ? `Say hi to ${supplierName} to get the thread started.`
                : `The buyer hasn't posted yet — feel free to drop them a note.`}
            </Empty>
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                viewerRole={viewerRole}
                onDelete={() => handleDelete(m)}
              />
            ))
          )}
        </div>
        <Composer
          disabled={activeId == null || busy}
          uploading={uploading}
          draft={draft}
          onDraftChange={setDraft}
          attachment={attachment}
          onAttach={handleAttach}
          onClearAttachment={() => setAttachment(null)}
          onSend={handleSend}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ChannelSidebar({
  supplierId,
  supplierName,
  viewerRole,
  channels,
  activeId,
  onSelect,
  onChanged,
}: {
  supplierId: number;
  supplierName: string;
  viewerRole: "buyer" | "supplier";
  channels: ChannelWithUnread[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function addChannel() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await createChannel({ supplierId, name });
      onChanged();
      onSelect(res.channelId);
      setNewName("");
      setAdding(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function commitRename(channelId: number) {
    const name = renameDraft.trim();
    if (!name) {
      setRenamingId(null);
      return;
    }
    setBusy(true);
    try {
      await renameChannel({ channelId, name });
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusy(false);
      setRenamingId(null);
    }
  }

  async function toggleArchive(channelId: number, archived: boolean) {
    if (archived && !confirm("Archive this channel? It'll be hidden for everyone but messages stay on the server.")) return;
    setBusy(true);
    try {
      await archiveChannel({ channelId, archived });
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      style={{
        borderRight: "1px solid var(--lb-border)",
        background: "var(--lb-bg-elev)",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <header style={{ padding: "12px 12px 8px", borderBottom: "1px solid var(--lb-border)" }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--lb-text-3)" }}>
          Chat
        </div>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: "var(--lb-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={supplierName}
        >
          {supplierName}
        </div>
      </header>
      <div style={{ flex: 1, overflowY: "auto", padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
        {channels.length === 0 && (
          <div style={{ padding: 10, fontSize: 11.5, color: "var(--lb-text-3)" }}>
            No channels yet.
          </div>
        )}
        {channels.map((c) => {
          const isActive = c.id === activeId;
          const isRenaming = renamingId === c.id;
          return (
            <div
              key={c.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px",
                borderRadius: 6,
                background: isActive ? "rgba(8,145,178,0.15)" : "transparent",
                border: isActive ? "1px solid rgba(8,145,178,0.4)" : "1px solid transparent",
                cursor: "pointer",
              }}
              onClick={() => !isRenaming && onSelect(c.id)}
              onDoubleClick={() => {
                if (viewerRole !== "buyer") return;
                setRenameDraft(c.name);
                setRenamingId(c.id);
              }}
              title={viewerRole === "buyer" ? "Double-click to rename" : undefined}
            >
              <span style={{ color: "var(--lb-text-3)" }}>#</span>
              {isRenaming ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(c.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "var(--lb-bg)",
                    border: "1px solid var(--lb-border)",
                    color: "var(--lb-text)",
                    fontSize: 12,
                    padding: "2px 6px",
                    borderRadius: 4,
                  }}
                />
              ) : (
                <>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      fontWeight: c.unreadCount > 0 ? 800 : 600,
                      color: "var(--lb-text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.name}
                  </span>
                  {c.unreadCount > 0 && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 800,
                        padding: "1px 6px",
                        borderRadius: 999,
                        background: "#dc2626",
                        color: "#fff",
                      }}
                    >
                      {c.unreadCount}
                    </span>
                  )}
                  {viewerRole === "buyer" && c.kind !== "default" && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleArchive(c.id, true); }}
                      disabled={busy}
                      title="Archive channel"
                      style={{ background: "transparent", border: 0, color: "var(--lb-text-3)", cursor: "pointer", fontSize: 11, padding: 0 }}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {viewerRole === "buyer" && (
        <div style={{ padding: 8, borderTop: "1px solid var(--lb-border)" }}>
          {adding ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addChannel();
                  if (e.key === "Escape") { setAdding(false); setNewName(""); }
                }}
                placeholder="e.g. Engineering, Logistics, AP"
                style={{
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                  color: "var(--lb-text)",
                  fontSize: 12,
                  padding: "5px 8px",
                  borderRadius: 5,
                }}
              />
              <div style={{ display: "flex", gap: 4 }}>
                <button type="button" disabled={busy || !newName.trim()} onClick={addChannel} style={tinyBtn("#16a34a")}>+ Create</button>
                <button type="button" onClick={() => { setAdding(false); setNewName(""); }} style={tinyBtn("#475569")}>Cancel</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              style={{
                width: "100%",
                padding: "6px 10px",
                background: "transparent",
                border: "1px dashed var(--lb-border)",
                color: "var(--lb-text-2)",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              + New channel
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function MessageBubble({
  msg,
  viewerRole,
  onDelete,
}: {
  msg: ChatMessage;
  viewerRole: "buyer" | "supplier";
  onDelete: () => void;
}) {
  // "Self" = the viewer authored this message → align right. We can't
  // compare clerk IDs without passing them in, so use role: same role as
  // viewer renders right-aligned. This matches the typical chat UX where
  // your team's messages are on the right side.
  const isSelf = msg.authorRole === viewerRole;
  const mineColor = msg.authorRole === "buyer" ? "rgba(8,145,178,0.2)" : "rgba(124,58,237,0.2)";
  const mineBorder = msg.authorRole === "buyer" ? "rgba(8,145,178,0.45)" : "rgba(124,58,237,0.45)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: isSelf ? "row-reverse" : "row",
        gap: 8,
        alignItems: "flex-end",
      }}
    >
      <div style={{ maxWidth: "78%" }}>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--lb-text-3)",
            marginBottom: 2,
            display: "flex",
            gap: 6,
            justifyContent: isSelf ? "flex-end" : "flex-start",
          }}
        >
          <strong style={{ color: "var(--lb-text-2)" }}>
            {msg.authorName ?? (msg.authorRole === "buyer" ? "Buyer" : "Supplier")}
          </strong>
          <span>· {new Date(msg.createdAt).toLocaleString()}</span>
        </div>
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            background: isSelf ? mineColor : "var(--lb-bg-elev)",
            border: `1px solid ${isSelf ? mineBorder : "var(--lb-border)"}`,
            color: "var(--lb-text)",
            fontSize: 13,
            whiteSpace: "pre-wrap",
            wordWrap: "break-word",
          }}
        >
          {msg.body}
          {msg.attachmentUrl && (
            <div style={{ marginTop: 6 }}>
              <a
                href={msg.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 12,
                  padding: "3px 8px",
                  borderRadius: 5,
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                  color: "var(--lb-accent)",
                  textDecoration: "none",
                }}
              >
                📎 {msg.attachmentName ?? "Download"}
              </a>
            </div>
          )}
        </div>
        {isSelf && (
          <div style={{ textAlign: "right", marginTop: 2 }}>
            <button
              type="button"
              onClick={onDelete}
              style={{ background: "transparent", border: 0, color: "var(--lb-text-3)", cursor: "pointer", fontSize: 10 }}
            >
              ✕ Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({
  disabled,
  uploading,
  draft,
  onDraftChange,
  attachment,
  onAttach,
  onClearAttachment,
  onSend,
}: {
  disabled: boolean;
  uploading: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  attachment: { url: string; name: string; pathname: string } | null;
  onAttach: (file: File) => void;
  onClearAttachment: () => void;
  onSend: () => void;
}) {
  return (
    <div style={{ borderTop: "1px solid var(--lb-border)", padding: 8, background: "var(--lb-bg-elev)" }}>
      {attachment && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 6px", fontSize: 11.5 }}>
          <span>📎 {attachment.name}</span>
          <button
            type="button"
            onClick={onClearAttachment}
            style={{ background: "transparent", border: 0, color: "#dc2626", cursor: "pointer", fontSize: 11 }}
          >
            ✕
          </button>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <label
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--lb-bg)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text-2)",
            cursor: uploading || disabled ? "wait" : "pointer",
            fontSize: 14,
            opacity: uploading || disabled ? 0.6 : 1,
          }}
          title="Attach file"
        >
          📎
          <input
            type="file"
            style={{ display: "none" }}
            disabled={uploading || disabled}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) onAttach(f);
            }}
          />
        </label>
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--lb-bg)",
            border: "1px solid var(--lb-border)",
            color: "var(--lb-text)",
            fontSize: 13,
            fontFamily: "inherit",
            minHeight: 36,
            maxHeight: 140,
          }}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || (!draft.trim() && !attachment)}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            background: "var(--lb-accent)",
            color: "var(--lb-accent-fg)",
            border: "1px solid var(--lb-accent)",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            opacity: disabled || (!draft.trim() && !attachment) ? 0.6 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        margin: "auto",
        padding: 14,
        borderRadius: 10,
        border: "1px dashed var(--lb-border)",
        textAlign: "center",
        color: "var(--lb-text-3)",
        fontSize: 12.5,
        maxWidth: 360,
      }}
    >
      {children}
    </div>
  );
}

function tinyBtn(color: string): React.CSSProperties {
  return {
    padding: "4px 8px",
    borderRadius: 5,
    background: `${color}22`,
    color,
    border: `1px solid ${color}66`,
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    flex: 1,
  };
}

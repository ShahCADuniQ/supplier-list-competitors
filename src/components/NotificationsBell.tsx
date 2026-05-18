"use client";

// Top-bar notifications bell. Polls listMyNotifications() every 30s + on
// open. Dropdown lists the 20 most recent — each row links to the
// associated RFQ / PO. Clicking a row marks it read; "Mark all read" at
// the bottom clears the unread badge.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  listMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/app/suppliers/rfq-actions";
import { NOTIFICATION_KIND_META } from "@/app/suppliers/_orders-constants";
import type { ErpNotification } from "@/db/schema";

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [recent, setRecent] = useState<ErpNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await listMyNotifications();
      setUnread(r.unread);
      setRecent(r.recent);
    } catch {
      // silent — bell shouldn't break the topbar
    } finally {
      setLoading(false);
    }
  }

  // Initial load + 30s poll
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  // Click-outside close
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function handleOpen() {
    setOpen((o) => !o);
    if (!open) refresh();
  }

  async function clickRow(n: ErpNotification) {
    if (!n.readAt) {
      try {
        await markNotificationRead(n.id);
        setUnread((u) => Math.max(0, u - 1));
        setRecent((r) => r.map((x) => (x.id === n.id ? { ...x, readAt: new Date() } : x)));
      } catch {/* swallow */}
    }
  }

  async function clearAll() {
    try {
      await markAllNotificationsRead();
      setUnread(0);
      setRecent((r) => r.map((x) => ({ ...x, readAt: x.readAt ?? new Date() })));
    } catch {/* swallow */}
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={handleOpen}
        aria-label="Notifications"
        title="Notifications"
        style={{
          position: "relative",
          width: 36,
          height: 36,
          borderRadius: 999,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          color: "var(--lb-text)",
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        🔔
        {unread > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              minWidth: 18,
              height: 18,
              padding: "0 5px",
              borderRadius: 999,
              background: "#dc2626",
              color: "#fff",
              fontSize: 10,
              fontWeight: 800,
              display: "grid",
              placeItems: "center",
              boxShadow: "0 0 0 2px var(--lb-bg)",
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: 42,
            right: 0,
            width: 380,
            maxHeight: 460,
            overflow: "auto",
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            borderRadius: 12,
            boxShadow: "0 12px 30px rgba(0,0,0,0.28)",
            zIndex: 60,
          }}
        >
          <header
            style={{
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottom: "1px solid var(--lb-border)",
            }}
          >
            <strong style={{ fontSize: 13, color: "var(--lb-text)" }}>Notifications</strong>
            {unread > 0 ? (
              <button
                type="button"
                onClick={clearAll}
                style={{ fontSize: 11, color: "var(--lb-accent)", background: "transparent", border: 0, fontWeight: 600, cursor: "pointer" }}
              >
                Mark all read
              </button>
            ) : (
              <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
                {loading ? "Refreshing…" : "Caught up"}
              </span>
            )}
          </header>
          {recent.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--lb-text-3)", fontSize: 12 }}>
              No notifications yet.
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {recent.map((n) => {
                const meta = NOTIFICATION_KIND_META[n.kind];
                const time = n.createdAt
                  ? new Date(n.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "";
                const isUnread = !n.readAt;
                const content = (
                  <li
                    onClick={() => clickRow(n)}
                    style={{
                      padding: "10px 14px",
                      borderBottom: "1px solid var(--lb-border)",
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      cursor: n.linkUrl ? "pointer" : "default",
                      background: isUnread ? "rgba(234,88,12,0.06)" : "transparent",
                    }}
                  >
                    <span
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: `${meta.color}22`,
                        color: meta.color,
                        display: "grid",
                        placeItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      {meta.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: isUnread ? 700 : 500, color: "var(--lb-text)" }}>
                        {n.title}
                      </div>
                      {n.body && (
                        <div style={{ fontSize: 11, color: "var(--lb-text-3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {n.body}
                        </div>
                      )}
                      <div style={{ fontSize: 10, color: "var(--lb-text-3)", marginTop: 2 }}>{time}</div>
                    </div>
                    {isUnread && (
                      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "#dc2626", flexShrink: 0, marginTop: 6 }} />
                    )}
                  </li>
                );
                return n.linkUrl ? (
                  <Link key={n.id} href={n.linkUrl} style={{ textDecoration: "none", color: "inherit" }} onClick={() => setOpen(false)}>
                    {content}
                  </Link>
                ) : (
                  <div key={n.id}>{content}</div>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

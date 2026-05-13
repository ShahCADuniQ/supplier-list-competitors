"use client";

// Customer 360 — the most important page in the CRM. Tabbed view of one
// account's full record: profile, contacts, opportunities (with stage
// editor), activity timeline (log new + delete), tickets (create + update).
// Every interaction routes through server actions and re-renders the page
// via router.refresh().

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  CrmAccount,
  CrmActivity,
  CrmContact,
  CrmOpportunity,
  CrmTicket,
} from "@/db/schema";
import {
  createContact,
  createOpportunity,
  createTicket,
  deleteAccount,
  deleteActivity,
  deleteContact,
  deleteOpportunity,
  deleteTicket,
  logActivity,
  updateAccount,
  updateContact,
  updateOpportunity,
  updateTicket,
} from "../../actions";
import {
  ACTIVITY_ICON,
  ACTIVITY_LABEL,
  STAGE_META,
  STAGE_ORDER,
  TICKET_PRIORITY_META,
  TICKET_STATUS_META,
  TIER_META,
  TIER_ORDER,
} from "../../constants";

function fmtUsd(n: number) {
  if (!Number.isFinite(n)) return "$0";
  if (Math.abs(n) >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtDateTime(d: Date | string) {
  const dt = new Date(d);
  return dt.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type TabKey = "timeline" | "contacts" | "opportunities" | "tickets" | "profile";

export default function AccountDetail({
  account,
  contacts,
  opportunities,
  activities,
  tickets,
}: {
  account: CrmAccount;
  contacts: CrmContact[];
  opportunities: CrmOpportunity[];
  activities: CrmActivity[];
  tickets: CrmTicket[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("timeline");
  const [, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);

  function ping(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  function run<T>(fn: () => Promise<T>, success?: string) {
    startTransition(async () => {
      try {
        await fn();
        if (success) ping(success);
        router.refresh();
      } catch (e) {
        ping(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  async function handleDelete() {
    if (
      !confirm(
        `Delete "${account.name}"? This removes the account AND all its contacts, opportunities, activities, and tickets.`,
      )
    )
      return;
    try {
      await deleteAccount(account.id);
      router.push("/crm/accounts");
    } catch (e) {
      ping(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const tm = TIER_META[account.tier];
  const openOpps = opportunities.filter(
    (o) => o.stage !== "won" && o.stage !== "lost",
  );
  const totalPipeline = openOpps.reduce(
    (s, o) => s + Number(o.amountUsd),
    0,
  );
  const closedWon = opportunities
    .filter((o) => o.stage === "won")
    .reduce((s, o) => s + Number(o.amountUsd), 0);
  const openTickets = tickets.filter(
    (t) => t.status !== "closed" && t.status !== "resolved",
  );

  return (
    <>
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            padding: "10px 16px",
            borderRadius: 8,
            background: "rgba(15,23,42,0.95)",
            color: "#fff",
            fontSize: 13,
            zIndex: 80,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
          }}
        >
          {toast}
        </div>
      )}

      {/* HERO */}
      <header
        style={{
          padding: "22px 26px",
          borderRadius: 14,
          background:
            "linear-gradient(155deg, var(--lb-bg-elev), var(--lb-bg))",
          border: "1px solid var(--lb-border)",
          display: "flex",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 52,
            height: 52,
            borderRadius: 12,
            background: `${tm.color}22`,
            color: tm.color,
            fontWeight: 800,
            fontSize: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {account.name.slice(0, 2).toUpperCase()}
        </span>
        <div style={{ flex: 1, minWidth: 260 }}>
          <input
            type="text"
            defaultValue={account.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== account.name) {
                run(() => updateAccount(account.id, { name: v }), "Saved");
              }
            }}
            style={{
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: "var(--lb-text)",
              background: "transparent",
              border: "none",
              outline: "none",
              width: "100%",
              padding: 0,
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              marginTop: 6,
              fontSize: 12.5,
              color: "var(--lb-text-3)",
            }}
          >
            <span
              style={{
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 5,
                background: `${tm.color}22`,
                color: tm.color,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              {tm.label}
            </span>
            {account.website && (
              <a
                href={account.website}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--lb-text-2)", textDecoration: "none" }}
              >
                {account.website.replace(/^https?:\/\//, "")} ↗
              </a>
            )}
            <span>{account.industry || "—"}</span>
            <span>{account.country || "—"}</span>
            <span>Health {account.healthScore}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          style={{
            alignSelf: "flex-start",
            padding: "8px 14px",
            borderRadius: 8,
            background: "transparent",
            color: "rgb(220,38,38)",
            border: "1px solid rgba(220,38,38,0.35)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Delete
        </button>
      </header>

      {/* KPI ROW */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
        }}
      >
        <KpiSm label="Contacts" value={contacts.length} />
        <KpiSm label="Open opps" value={openOpps.length} />
        <KpiSm label="Pipeline" value={fmtUsd(totalPipeline)} text />
        <KpiSm label="Closed won" value={fmtUsd(closedWon)} text accent="#16a34a" />
        <KpiSm
          label="Open tickets"
          value={openTickets.length}
          accent={openTickets.length > 0 ? "#dc2626" : undefined}
        />
        <KpiSm label="Activities" value={activities.length} />
      </section>

      {/* TABS */}
      <nav
        role="tablist"
        aria-label="Account sections"
        style={{
          display: "flex",
          gap: 6,
          padding: "8px 10px",
          borderRadius: 999,
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          width: "fit-content",
          overflowX: "auto",
        }}
      >
        {(
          [
            { key: "timeline", label: `Activity (${activities.length})` },
            { key: "contacts", label: `Contacts (${contacts.length})` },
            {
              key: "opportunities",
              label: `Opportunities (${opportunities.length})`,
            },
            { key: "tickets", label: `Tickets (${tickets.length})` },
            { key: "profile", label: "Profile" },
          ] as Array<{ key: TabKey; label: string }>
        ).map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              style={{
                padding: "7px 14px",
                borderRadius: 999,
                background: active ? "var(--lb-accent)" : "transparent",
                color: active ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
                border: active
                  ? "1px solid var(--lb-accent)"
                  : "1px solid transparent",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === "timeline" && (
        <TimelineTab
          account={account}
          contacts={contacts}
          opportunities={opportunities}
          activities={activities}
          ping={ping}
          run={run}
        />
      )}
      {tab === "contacts" && (
        <ContactsTab account={account} contacts={contacts} ping={ping} run={run} />
      )}
      {tab === "opportunities" && (
        <OpportunitiesTab
          account={account}
          opportunities={opportunities}
          ping={ping}
          run={run}
        />
      )}
      {tab === "tickets" && (
        <TicketsTab
          account={account}
          contacts={contacts}
          tickets={tickets}
          ping={ping}
          run={run}
        />
      )}
      {tab === "profile" && (
        <ProfileTab account={account} ping={ping} run={run} />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY TIMELINE
// ─────────────────────────────────────────────────────────────────────────────

function TimelineTab({
  account,
  contacts,
  opportunities,
  activities,
  ping,
  run,
}: {
  account: CrmAccount;
  contacts: CrmContact[];
  opportunities: CrmOpportunity[];
  activities: CrmActivity[];
  ping: (m: string) => void;
  run: <T>(fn: () => Promise<T>, success?: string) => void;
}) {
  const [type, setType] = useState<CrmActivity["type"]>("note");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [contactId, setContactId] = useState<number | "">("");
  const [opportunityId, setOpportunityId] = useState<number | "">("");

  function submit() {
    if (!subject.trim()) {
      ping("Subject is required");
      return;
    }
    run(
      () =>
        logActivity({
          accountId: account.id,
          type,
          subject,
          body: body || undefined,
          contactId: contactId || null,
          opportunityId: opportunityId || null,
        }),
      `${ACTIVITY_LABEL[type]} logged`,
    );
    setSubject("");
    setBody("");
    setContactId("");
    setOpportunityId("");
  }

  return (
    <>
      <Card title="Log activity">
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          {(Object.keys(ACTIVITY_LABEL) as CrmActivity["type"][]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                background: type === t ? "var(--lb-accent)" : "var(--lb-bg)",
                color:
                  type === t ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
                border:
                  type === t
                    ? "1px solid var(--lb-accent)"
                    : "1px solid var(--lb-border)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {ACTIVITY_ICON[t]} {ACTIVITY_LABEL[t]}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject (e.g. 'Discovery call with Sarah re: Q3 roll-out')"
          style={INPUT}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Notes (optional)"
          rows={3}
          style={{ ...INPUT, marginTop: 8, fontFamily: "inherit", resize: "vertical" }}
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginTop: 8,
          }}
        >
          <select
            value={contactId}
            onChange={(e) => setContactId(e.target.value ? Number(e.target.value) : "")}
            style={INPUT}
          >
            <option value="">No contact linked</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstName} {c.lastName}
              </option>
            ))}
          </select>
          <select
            value={opportunityId}
            onChange={(e) =>
              setOpportunityId(e.target.value ? Number(e.target.value) : "")
            }
            style={INPUT}
          >
            <option value="">No opportunity linked</option>
            {opportunities.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title} · {STAGE_META[o.stage].label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button
            type="button"
            onClick={submit}
            style={{
              padding: "8px 18px",
              borderRadius: 8,
              background: "var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              border: "1px solid var(--lb-accent)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Log {ACTIVITY_LABEL[type]}
          </button>
        </div>
      </Card>

      <Card title={`Timeline (${activities.length})`}>
        {activities.length === 0 ? (
          <Empty msg="Nothing yet. Log a call, email, meeting, or note above." />
        ) : (
          <ol
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 0,
              position: "relative",
            }}
          >
            {activities.map((a, idx) => (
              <li
                key={a.id}
                style={{
                  display: "flex",
                  gap: 12,
                  paddingBottom: idx === activities.length - 1 ? 0 : 14,
                  position: "relative",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "var(--lb-bg)",
                    border: "1px solid var(--lb-border)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    fontSize: 14,
                    zIndex: 1,
                  }}
                >
                  {ACTIVITY_ICON[a.type]}
                </span>
                {idx < activities.length - 1 && (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: 16,
                      top: 32,
                      bottom: 0,
                      width: 1,
                      background: "var(--lb-border)",
                    }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                      {a.subject}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: "var(--lb-bg)",
                        color: "var(--lb-text-3)",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: 0.6,
                      }}
                    >
                      {ACTIVITY_LABEL[a.type]}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--lb-text-3)" }}>
                      {fmtDateTime(a.occurredAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        run(() => deleteActivity(a.id), "Deleted")
                      }
                      aria-label="Delete activity"
                      style={{
                        marginLeft: "auto",
                        padding: "2px 8px",
                        borderRadius: 5,
                        background: "transparent",
                        color: "var(--lb-text-3)",
                        border: "1px solid transparent",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {a.body && (
                    <p
                      style={{
                        margin: "4px 0 0",
                        fontSize: 13,
                        color: "var(--lb-text-2)",
                        lineHeight: 1.5,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {a.body}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────────────────────────────────────

function ContactsTab({
  account,
  contacts,
  ping,
  run,
}: {
  account: CrmAccount;
  contacts: CrmContact[];
  ping: (m: string) => void;
  run: <T>(fn: () => Promise<T>, success?: string) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");

  function submit() {
    if (!firstName.trim()) {
      ping("First name is required");
      return;
    }
    run(
      () =>
        createContact({
          accountId: account.id,
          firstName,
          lastName,
          email: email || undefined,
          phone: phone || undefined,
          role: role || undefined,
          isPrimary: contacts.length === 0,
        }),
      "Contact added",
    );
    setFirstName("");
    setLastName("");
    setEmail("");
    setPhone("");
    setRole("");
  }

  return (
    <>
      <Card title="Add contact">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 8,
          }}
        >
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="First name *"
            style={INPUT}
          />
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
            style={INPUT}
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            style={INPUT}
          />
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone"
            style={INPUT}
          />
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role (e.g. Buyer)"
            style={INPUT}
          />
          <button
            type="button"
            onClick={submit}
            style={{
              padding: "9px 16px",
              borderRadius: 8,
              background: "var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              border: "1px solid var(--lb-accent)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            + Add contact
          </button>
        </div>
      </Card>

      <Card title={`Contacts (${contacts.length})`}>
        {contacts.length === 0 ? (
          <Empty msg="No contacts yet. Add one above." />
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {contacts.map((c) => (
              <li
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "var(--lb-bg)",
                  border: "1px solid var(--lb-border)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 999,
                    background: "var(--lb-bg-elev)",
                    color: "var(--lb-text)",
                    fontWeight: 800,
                    fontSize: 12,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {(c.firstName[0] ?? "").toUpperCase()}
                  {(c.lastName[0] ?? "").toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                    {c.firstName} {c.lastName}
                    {c.isPrimary && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 9.5,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "rgba(124,58,237,0.18)",
                          color: "rgb(124,58,237)",
                          fontWeight: 800,
                          textTransform: "uppercase",
                          letterSpacing: 0.6,
                        }}
                      >
                        Primary
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--lb-text-3)",
                      marginTop: 2,
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 10,
                    }}
                  >
                    {c.role && <span>{c.role}</span>}
                    {c.email && (
                      <a
                        href={`mailto:${c.email}`}
                        style={{
                          color: "var(--lb-text-2)",
                          textDecoration: "none",
                        }}
                      >
                        {c.email}
                      </a>
                    )}
                    {c.phone && <span>{c.phone}</span>}
                  </div>
                </div>
                {!c.isPrimary && (
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        () => updateContact(c.id, { isPrimary: true }),
                        "Marked primary",
                      )
                    }
                    style={{
                      padding: "5px 10px",
                      borderRadius: 6,
                      background: "transparent",
                      color: "var(--lb-text-2)",
                      border: "1px solid var(--lb-border)",
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Mark primary
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    confirm(`Delete ${c.firstName} ${c.lastName}?`) &&
                    run(() => deleteContact(c.id), "Deleted")
                  }
                  aria-label="Delete contact"
                  style={{
                    padding: "5px 10px",
                    borderRadius: 6,
                    background: "transparent",
                    color: "rgb(220,38,38)",
                    border: "1px solid var(--lb-border)",
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OPPORTUNITIES
// ─────────────────────────────────────────────────────────────────────────────

function OpportunitiesTab({
  account,
  opportunities,
  ping,
  run,
}: {
  account: CrmAccount;
  opportunities: CrmOpportunity[];
  ping: (m: string) => void;
  run: <T>(fn: () => Promise<T>, success?: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [probability, setProbability] = useState("20");
  const [stage, setStage] = useState<CrmOpportunity["stage"]>("lead");
  const [expectedClose, setExpectedClose] = useState("");

  function submit() {
    if (!title.trim()) {
      ping("Title is required");
      return;
    }
    run(
      () =>
        createOpportunity({
          accountId: account.id,
          title,
          amountUsd: Number(amount) || 0,
          probability: Number(probability) || 20,
          stage,
          expectedCloseDate: expectedClose || null,
        }),
      "Opportunity created",
    );
    setTitle("");
    setAmount("");
    setProbability("20");
    setStage("lead");
    setExpectedClose("");
  }

  return (
    <>
      <Card title="New opportunity">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr 1fr 1fr",
            gap: 8,
          }}
        >
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. 'Q3 Pilot — 200 units')"
            style={INPUT}
          />
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount USD"
            min={0}
            step={100}
            style={INPUT}
          />
          <input
            type="number"
            value={probability}
            onChange={(e) => setProbability(e.target.value)}
            placeholder="Prob %"
            min={0}
            max={100}
            style={INPUT}
          />
          <input
            type="date"
            value={expectedClose}
            onChange={(e) => setExpectedClose(e.target.value)}
            style={INPUT}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 8,
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <select
            value={stage}
            onChange={(e) => setStage(e.target.value as CrmOpportunity["stage"])}
            style={{ ...INPUT, width: "auto", minWidth: 160 }}
          >
            {STAGE_ORDER.map((s) => (
              <option key={s} value={s}>
                {STAGE_META[s].label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={submit}
            style={{
              padding: "9px 16px",
              borderRadius: 8,
              background: "var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              border: "1px solid var(--lb-accent)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            + Create opportunity
          </button>
        </div>
      </Card>

      <Card title={`Opportunities (${opportunities.length})`}>
        {opportunities.length === 0 ? (
          <Empty msg="No opportunities yet." />
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {opportunities.map((o) => (
              <OpportunityRow
                key={o.id}
                opp={o}
                onPatch={(patch) =>
                  run(() => updateOpportunity(o.id, patch), "Saved")
                }
                onDelete={() =>
                  confirm(`Delete "${o.title}"?`) &&
                  run(() => deleteOpportunity(o.id), "Deleted")
                }
              />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function OpportunityRow({
  opp,
  onPatch,
  onDelete,
}: {
  opp: CrmOpportunity;
  onPatch: (patch: Partial<{
    title: string;
    stage: CrmOpportunity["stage"];
    amountUsd: number;
    probability: number;
    expectedCloseDate: string | null;
    nextStep: string;
  }>) => void;
  onDelete: () => void;
}) {
  const meta = STAGE_META[opp.stage];
  return (
    <li
      style={{
        padding: 14,
        borderRadius: 10,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        borderLeft: `4px solid ${meta.color}`,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input
          type="text"
          defaultValue={opp.title}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== opp.title) onPatch({ title: v });
          }}
          style={{
            flex: 1,
            minWidth: 200,
            fontSize: 14,
            fontWeight: 700,
            background: "transparent",
            border: "none",
            color: "var(--lb-text)",
            padding: 0,
          }}
        />
        <input
          type="number"
          defaultValue={Number(opp.amountUsd)}
          min={0}
          step={100}
          onBlur={(e) => {
            const v = Number(e.target.value) || 0;
            if (v !== Number(opp.amountUsd)) onPatch({ amountUsd: v });
          }}
          style={{ ...INPUT, width: 120 }}
        />
        <input
          type="number"
          defaultValue={opp.probability}
          min={0}
          max={100}
          onBlur={(e) => {
            const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
            if (v !== opp.probability) onPatch({ probability: v });
          }}
          style={{ ...INPUT, width: 80 }}
          title="Win probability %"
        />
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete opportunity"
          style={{
            padding: "5px 10px",
            borderRadius: 6,
            background: "transparent",
            color: "rgb(220,38,38)",
            border: "1px solid var(--lb-border)",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {STAGE_ORDER.map((s) => {
          const sm = STAGE_META[s];
          const active = s === opp.stage;
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                if (s !== opp.stage) onPatch({ stage: s });
              }}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                background: active ? sm.color : "var(--lb-bg-elev)",
                color: active ? "#fff" : sm.color,
                border: active
                  ? `1px solid ${sm.color}`
                  : `1px solid ${sm.color}33`,
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              {sm.label}
            </button>
          );
        })}
      </div>
      <input
        type="text"
        defaultValue={opp.nextStep ?? ""}
        placeholder="Next step (e.g. 'Send pricing proposal by Friday')"
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== (opp.nextStep ?? "")) onPatch({ nextStep: v });
        }}
        style={{ ...INPUT, fontSize: 12.5 }}
      />
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TICKETS
// ─────────────────────────────────────────────────────────────────────────────

function TicketsTab({
  account,
  contacts,
  tickets,
  ping,
  run,
}: {
  account: CrmAccount;
  contacts: CrmContact[];
  tickets: CrmTicket[];
  ping: (m: string) => void;
  run: <T>(fn: () => Promise<T>, success?: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<CrmTicket["priority"]>("medium");
  const [contactId, setContactId] = useState<number | "">("");

  function submit() {
    if (!subject.trim()) {
      ping("Subject is required");
      return;
    }
    run(
      () =>
        createTicket({
          accountId: account.id,
          subject,
          body: body || undefined,
          priority,
          contactId: contactId || null,
        }),
      "Ticket created",
    );
    setSubject("");
    setBody("");
    setPriority("medium");
    setContactId("");
  }

  return (
    <>
      <Card title="New ticket">
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject (e.g. 'Mismatched dimension on FAIR — request rework')"
          style={INPUT}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Description (optional)"
          rows={3}
          style={{ ...INPUT, marginTop: 8, fontFamily: "inherit", resize: "vertical" }}
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr auto",
            gap: 8,
            marginTop: 8,
          }}
        >
          <select
            value={priority}
            onChange={(e) =>
              setPriority(e.target.value as CrmTicket["priority"])
            }
            style={INPUT}
          >
            {(["low", "medium", "high", "urgent"] as const).map((p) => (
              <option key={p} value={p}>
                {TICKET_PRIORITY_META[p].label}
              </option>
            ))}
          </select>
          <select
            value={contactId}
            onChange={(e) =>
              setContactId(e.target.value ? Number(e.target.value) : "")
            }
            style={INPUT}
          >
            <option value="">No contact linked</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstName} {c.lastName}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={submit}
            style={{
              padding: "9px 16px",
              borderRadius: 8,
              background: "var(--lb-accent)",
              color: "var(--lb-accent-fg)",
              border: "1px solid var(--lb-accent)",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            + Open ticket
          </button>
        </div>
      </Card>

      <Card title={`Tickets (${tickets.length})`}>
        {tickets.length === 0 ? (
          <Empty msg="No tickets yet." />
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {tickets.map((t) => {
              const sm = TICKET_STATUS_META[t.status];
              const pm = TICKET_PRIORITY_META[t.priority];
              return (
                <li
                  key={t.id}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    background: "var(--lb-bg)",
                    border: "1px solid var(--lb-border)",
                    borderLeft: `4px solid ${pm.color}`,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 200 }}>
                      {t.subject}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: "2px 8px",
                        borderRadius: 5,
                        background: `${pm.color}22`,
                        color: pm.color,
                        fontWeight: 800,
                        textTransform: "uppercase",
                        letterSpacing: 0.6,
                      }}
                    >
                      {pm.label}
                    </span>
                    <select
                      value={t.status}
                      onChange={(e) =>
                        run(
                          () =>
                            updateTicket(t.id, {
                              status: e.target.value as CrmTicket["status"],
                            }),
                          "Updated",
                        )
                      }
                      style={{
                        ...INPUT,
                        width: "auto",
                        background: `${sm.color}11`,
                        borderColor: `${sm.color}55`,
                        color: sm.color,
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {(
                        Object.keys(
                          TICKET_STATUS_META,
                        ) as CrmTicket["status"][]
                      ).map((s) => (
                        <option key={s} value={s}>
                          {TICKET_STATUS_META[s].label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        confirm(`Delete ticket "${t.subject}"?`) &&
                        run(() => deleteTicket(t.id), "Deleted")
                      }
                      aria-label="Delete ticket"
                      style={{
                        padding: "4px 10px",
                        borderRadius: 6,
                        background: "transparent",
                        color: "rgb(220,38,38)",
                        border: "1px solid var(--lb-border)",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {t.body && (
                    <p
                      style={{
                        margin: 0,
                        fontSize: 12.5,
                        color: "var(--lb-text-2)",
                        lineHeight: 1.5,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {t.body}
                    </p>
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--lb-text-3)",
                    }}
                  >
                    Opened {fmtDateTime(t.createdAt)}
                    {t.resolvedAt &&
                      ` · Resolved ${fmtDateTime(t.resolvedAt)}`}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────────────────────────────────────────

function ProfileTab({
  account,
  ping,
  run,
}: {
  account: CrmAccount;
  ping: (m: string) => void;
  run: <T>(fn: () => Promise<T>, success?: string) => void;
}) {
  return (
    <Card title="Company profile">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
        }}
      >
        <Field label="Website">
          <input
            type="url"
            defaultValue={account.website ?? ""}
            placeholder="https://…"
            onBlur={(e) =>
              run(() => updateAccount(account.id, { website: e.target.value }), "Saved")
            }
            style={INPUT}
          />
        </Field>
        <Field label="Industry">
          <input
            type="text"
            defaultValue={account.industry ?? ""}
            onBlur={(e) =>
              run(() => updateAccount(account.id, { industry: e.target.value }), "Saved")
            }
            style={INPUT}
          />
        </Field>
        <Field label="Country">
          <input
            type="text"
            defaultValue={account.country ?? ""}
            onBlur={(e) =>
              run(() => updateAccount(account.id, { country: e.target.value }), "Saved")
            }
            style={INPUT}
          />
        </Field>
        <Field label="Employee count">
          <input
            type="number"
            defaultValue={account.employeeCount ?? ""}
            min={0}
            onBlur={(e) =>
              run(
                () =>
                  updateAccount(account.id, {
                    employeeCount: e.target.value
                      ? Number(e.target.value)
                      : null,
                  }),
                "Saved",
              )
            }
            style={INPUT}
          />
        </Field>
        <Field label="Annual revenue (USD)">
          <input
            type="number"
            defaultValue={account.annualRevenueUsd ?? ""}
            min={0}
            step={1000}
            onBlur={(e) =>
              run(
                () =>
                  updateAccount(account.id, {
                    annualRevenueUsd: e.target.value || null,
                  }),
                "Saved",
              )
            }
            style={INPUT}
          />
        </Field>
        <Field label="Health score (0-100)">
          <input
            type="number"
            defaultValue={account.healthScore}
            min={0}
            max={100}
            onBlur={(e) =>
              run(
                () =>
                  updateAccount(account.id, {
                    healthScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                  }),
                "Saved",
              )
            }
            style={INPUT}
          />
        </Field>
      </div>
      <Field label="Tier">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
          {TIER_ORDER.map((t) => {
            const m = TIER_META[t];
            const active = account.tier === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => run(() => updateAccount(account.id, { tier: t }), "Saved")}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: active ? m.color : "var(--lb-bg)",
                  color: active ? "#fff" : m.color,
                  border: active ? `1px solid ${m.color}` : `1px solid ${m.color}55`,
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Notes">
        <textarea
          defaultValue={account.notes ?? ""}
          placeholder="Internal notes — anything sales / success / support should know."
          rows={5}
          onBlur={(e) =>
            run(() => updateAccount(account.id, { notes: e.target.value }), "Saved")
          }
          style={{ ...INPUT, fontFamily: "inherit", resize: "vertical" }}
        />
      </Field>
      <p
        style={{
          fontSize: 11.5,
          color: "var(--lb-text-3)",
          margin: "4px 0 0",
        }}
      >
        Fields save on blur. Account #{account.id} · Created{" "}
        {fmtDateTime(account.createdAt)} · Updated {fmtDateTime(account.updatedAt)}
      </p>
      {void ping}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

const INPUT: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
  fontSize: 13,
  width: "100%",
};

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: "16px 20px",
        borderRadius: 14,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h2
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
          margin: 0,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          color: "var(--lb-text-3)",
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function KpiSm({
  label,
  value,
  text,
  accent,
}: {
  label: string;
  value: number | string;
  text?: boolean;
  accent?: string;
}) {
  return (
    <div
      style={{
        padding: "10px 14px",
        borderRadius: 10,
        background: "var(--lb-bg-elev)",
        border: "1px solid var(--lb-border)",
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: text ? 16 : 20,
          fontWeight: 800,
          marginTop: 2,
          color: accent ?? "var(--lb-text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div
      style={{
        padding: "20px 18px",
        borderRadius: 10,
        border: "1px dashed var(--lb-border)",
        textAlign: "center",
        color: "var(--lb-text-2)",
        fontSize: 13,
      }}
    >
      {msg}
    </div>
  );
}

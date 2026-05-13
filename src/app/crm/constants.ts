// Shared CRM display metadata — used by every page so badges, colours, and
// stage labels stay consistent across the dashboard, the kanban, account
// detail, and the analytics view.

import type {
  CrmAccount,
  CrmActivity,
  CrmOpportunity,
  CrmTicket,
} from "@/db/schema";

export const STAGE_META: Record<
  CrmOpportunity["stage"],
  { label: string; color: string; isTerminal: boolean; isOpen: boolean }
> = {
  lead: {
    label: "Lead",
    color: "#6b7280",
    isTerminal: false,
    isOpen: true,
  },
  qualified: {
    label: "Qualified",
    color: "#0891b2",
    isTerminal: false,
    isOpen: true,
  },
  demo: {
    label: "Demo",
    color: "#2563eb",
    isTerminal: false,
    isOpen: true,
  },
  proposal: {
    label: "Proposal",
    color: "#7c3aed",
    isTerminal: false,
    isOpen: true,
  },
  negotiation: {
    label: "Negotiation",
    color: "#db2777",
    isTerminal: false,
    isOpen: true,
  },
  won: {
    label: "Won",
    color: "#16a34a",
    isTerminal: true,
    isOpen: false,
  },
  lost: {
    label: "Lost",
    color: "#dc2626",
    isTerminal: true,
    isOpen: false,
  },
  "on-hold": {
    label: "On Hold",
    color: "#ca8a04",
    isTerminal: false,
    isOpen: true,
  },
};

export const STAGE_ORDER: Array<CrmOpportunity["stage"]> = [
  "lead",
  "qualified",
  "demo",
  "proposal",
  "negotiation",
  "won",
  "lost",
  "on-hold",
];

export const TIER_META: Record<
  CrmAccount["tier"],
  { label: string; color: string }
> = {
  lead: { label: "Lead", color: "#6b7280" },
  prospect: { label: "Prospect", color: "#2563eb" },
  customer: { label: "Customer", color: "#16a34a" },
  partner: { label: "Partner", color: "#7c3aed" },
  churned: { label: "Churned", color: "#dc2626" },
};

export const TIER_ORDER: Array<CrmAccount["tier"]> = [
  "lead",
  "prospect",
  "customer",
  "partner",
  "churned",
];

export const ACTIVITY_ICON: Record<CrmActivity["type"], string> = {
  call: "📞",
  email: "✉️",
  meeting: "🤝",
  note: "📝",
  task: "☑️",
};

export const ACTIVITY_LABEL: Record<CrmActivity["type"], string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  note: "Note",
  task: "Task",
};

export const TICKET_STATUS_META: Record<
  CrmTicket["status"],
  { label: string; color: string }
> = {
  open: { label: "Open", color: "#dc2626" },
  "in-progress": { label: "In Progress", color: "#ca8a04" },
  resolved: { label: "Resolved", color: "#16a34a" },
  closed: { label: "Closed", color: "#6b7280" },
};

export const TICKET_PRIORITY_META: Record<
  CrmTicket["priority"],
  { label: string; color: string }
> = {
  low: { label: "Low", color: "#6b7280" },
  medium: { label: "Medium", color: "#2563eb" },
  high: { label: "High", color: "#ea580c" },
  urgent: { label: "Urgent", color: "#dc2626" },
};

// Shared OEE display metadata — used by the dashboard, machine grid, alert
// table, and analytics view so the same status/reason/severity stays colour-
// matched everywhere.

import type {
  OeeAlert,
  OeeDowntimeEvent,
  OeeMachine,
  OeeQualityEvent,
} from "@/db/schema";

export const STATUS_META: Record<
  OeeMachine["status"],
  { label: string; color: string; isProductive: boolean }
> = {
  running: { label: "Running", color: "#16a34a", isProductive: true },
  idle: { label: "Idle", color: "#6b7280", isProductive: false },
  down: { label: "Down", color: "#dc2626", isProductive: false },
  maintenance: { label: "Maintenance", color: "#ca8a04", isProductive: false },
  offline: { label: "Offline", color: "#475569", isProductive: false },
};

export const STATUS_ORDER: Array<OeeMachine["status"]> = [
  "running",
  "idle",
  "down",
  "maintenance",
  "offline",
];

export const DOWNTIME_REASON_META: Record<
  OeeDowntimeEvent["reason"],
  { label: string; color: string; category: OeeDowntimeEvent["category"] }
> = {
  breakdown: { label: "Breakdown", color: "#dc2626", category: "unplanned" },
  setup: { label: "Setup", color: "#0891b2", category: "planned" },
  material: { label: "Material wait", color: "#ea580c", category: "unplanned" },
  changeover: { label: "Changeover", color: "#2563eb", category: "planned" },
  maintenance: { label: "Maintenance", color: "#ca8a04", category: "planned" },
  "no-operator": {
    label: "No operator",
    color: "#7c3aed",
    category: "unplanned",
  },
  "quality-hold": {
    label: "Quality hold",
    color: "#db2777",
    category: "unplanned",
  },
  other: { label: "Other", color: "#475569", category: "unplanned" },
};

export const DOWNTIME_REASON_ORDER: Array<OeeDowntimeEvent["reason"]> = [
  "breakdown",
  "setup",
  "material",
  "changeover",
  "maintenance",
  "no-operator",
  "quality-hold",
  "other",
];

export const QUALITY_TYPE_META: Record<
  OeeQualityEvent["type"],
  { label: string; color: string }
> = {
  scrap: { label: "Scrap", color: "#dc2626" },
  rework: { label: "Rework", color: "#ca8a04" },
  defect: { label: "Defect", color: "#7c3aed" },
};

export const ALERT_SEVERITY_META: Record<
  OeeAlert["severity"],
  { label: string; color: string }
> = {
  info: { label: "Info", color: "#0891b2" },
  warning: { label: "Warning", color: "#ea580c" },
  critical: { label: "Critical", color: "#dc2626" },
};

export const ALERT_STATUS_META: Record<
  OeeAlert["status"],
  { label: string; color: string }
> = {
  open: { label: "Open", color: "#dc2626" },
  acknowledged: { label: "Acknowledged", color: "#ca8a04" },
  resolved: { label: "Resolved", color: "#16a34a" },
  escalated: { label: "Escalated to CRM", color: "#7c3aed" },
};

// OEE rating bands — used to colour the headline KPI tiles. World-class OEE
// is ~85% in discrete manufacturing, anything below 40% is in crisis. Tune
// per industry if needed.
export function oeeBand(oeeFraction: number): {
  label: string;
  color: string;
} {
  if (oeeFraction >= 0.85)
    return { label: "World class", color: "#16a34a" };
  if (oeeFraction >= 0.65) return { label: "Typical", color: "#0891b2" };
  if (oeeFraction >= 0.4) return { label: "Below par", color: "#ca8a04" };
  return { label: "Critical", color: "#dc2626" };
}

export function fmtPct(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d}d` : `${d}d ${rh}h`;
}

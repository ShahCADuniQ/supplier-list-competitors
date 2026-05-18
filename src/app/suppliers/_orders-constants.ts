// Shared display metadata for the ERP procurement workflow — used by the
// Orders tab, the vendor portal, the PO print view, and the notification
// bell so colours / labels stay consistent everywhere.

import type {
  ErpNotification,
  PurchaseOrder,
  Rfq,
  RfqRecipient,
  SupplierQuote,
} from "@/db/schema";

export const RFQ_STATUS_META: Record<
  Rfq["status"],
  { label: string; color: string }
> = {
  draft: { label: "Draft", color: "#6b7280" },
  sent: { label: "Sent", color: "#2563eb" },
  "quotes-in": { label: "Quotes In", color: "#0891b2" },
  reviewed: { label: "Reviewed", color: "#7c3aed" },
  awarded: { label: "Awarded", color: "#16a34a" },
  closed: { label: "Closed", color: "#475569" },
  cancelled: { label: "Cancelled", color: "#dc2626" },
};

export const RFQ_STAGE_META: Record<
  Rfq["stage"],
  { label: string; color: string; description: string }
> = {
  selection: {
    label: "Selection",
    color: "#0891b2",
    description:
      "Shopping the market — multiple suppliers competing. Quotes are compared side-by-side and the best one is awarded.",
  },
  committed: {
    label: "Committed",
    color: "#16a34a",
    description:
      "Supplier already chosen. We just need the quote on paper so the PO can be issued.",
  },
};

export const TRANSPORT_MODE_META: Record<
  Rfq["transportMode"],
  { label: string; color: string; icon: string }
> = {
  air: { label: "Air", color: "#0891b2", icon: "✈" },
  sea: { label: "Sea", color: "#2563eb", icon: "🚢" },
  truck: { label: "Truck", color: "#ca8a04", icon: "🚚" },
  rail: { label: "Rail", color: "#7c3aed", icon: "🚆" },
  courier: { label: "Courier", color: "#16a34a", icon: "📦" },
  any: { label: "Any (supplier choice)", color: "#6b7280", icon: "—" },
};

export const TRANSPORT_MODE_ORDER: Array<Rfq["transportMode"]> = [
  "air",
  "sea",
  "truck",
  "rail",
  "courier",
  "any",
];

export const QUOTE_STATUS_META: Record<
  SupplierQuote["status"],
  { label: string; color: string }
> = {
  invited: { label: "Invited", color: "#6b7280" },
  viewed: { label: "Viewed", color: "#ca8a04" },
  draft: { label: "Draft", color: "#ca8a04" },
  submitted: { label: "Submitted", color: "#16a34a" },
  declined: { label: "Declined", color: "#dc2626" },
  expired: { label: "Expired", color: "#475569" },
};

export const PO_STATUS_META: Record<
  PurchaseOrder["status"],
  { label: string; color: string }
> = {
  draft: { label: "Draft", color: "#6b7280" },
  sent: { label: "Sent", color: "#2563eb" },
  acknowledged: { label: "Acknowledged", color: "#0891b2" },
  "in-production": { label: "In Production", color: "#ca8a04" },
  shipped: { label: "Shipped", color: "#7c3aed" },
  received: { label: "Received", color: "#16a34a" },
  closed: { label: "Closed", color: "#475569" },
  cancelled: { label: "Cancelled", color: "#dc2626" },
};

export const NOTIFICATION_KIND_META: Record<
  ErpNotification["kind"],
  { icon: string; color: string }
> = {
  "rfq.sent": { icon: "📨", color: "#2563eb" },
  "rfq.quote-received": { icon: "💬", color: "#0891b2" },
  "rfq.awarded": { icon: "🏆", color: "#16a34a" },
  "po.issued": { icon: "📝", color: "#7c3aed" },
  "po.acknowledged": { icon: "✅", color: "#0891b2" },
  "po.shipped": { icon: "🚚", color: "#ca8a04" },
  "supplier.signed-up": { icon: "🆕", color: "#16a34a" },
  "supplier.status-update": { icon: "🔔", color: "#0891b2" },
  // Migration 0029 — payment + tracking workflow
  "po.payment-method-set": { icon: "💳", color: "#0891b2" },
  "po.invoice-issued":     { icon: "🧾", color: "#7c3aed" },
  "po.invoice-status":     { icon: "💼", color: "#16a34a" },
  "po.payment-recorded":   { icon: "💸", color: "#059669" },
  "po.timeline-update":    { icon: "📦", color: "#ca8a04" },
};

export const INCOTERM_OPTIONS = [
  "EXW",
  "FOB",
  "CIF",
  "CFR",
  "DAP",
  "DDP",
  "FCA",
  "FAS",
  "CPT",
  "CIP",
  "DPU",
] as const;

// Incoterms® 2020 definitions — plain-English explanation of who is
// responsible for what at each stage of shipping. Used by the IncotermSelect
// component to render a tooltip on the (?) icon beside each option.
export const INCOTERM_META: Record<
  (typeof INCOTERM_OPTIONS)[number],
  { full: string; mode: string; summary: string }
> = {
  EXW: {
    full: "Ex Works",
    mode: "Any mode",
    summary:
      "Seller makes goods available at their premises. Buyer takes on every cost and risk from there — loading, export clearance, freight, insurance, import, delivery. Cheapest for seller, most work for buyer.",
  },
  FCA: {
    full: "Free Carrier",
    mode: "Any mode",
    summary:
      "Seller delivers goods, cleared for export, to a named carrier or place chosen by the buyer. Risk transfers once handed over. Common when buyer arranges the main freight.",
  },
  FAS: {
    full: "Free Alongside Ship",
    mode: "Sea / inland waterway",
    summary:
      "Seller delivers goods alongside the buyer's nominated vessel at the named port. Buyer covers loading onto the ship and everything after. Bulk cargo only.",
  },
  FOB: {
    full: "Free On Board",
    mode: "Sea / inland waterway",
    summary:
      "Seller loads goods onto the buyer's ship at the named port and clears for export. Risk + cost transfer once goods are on board. Buyer arranges main freight and insurance.",
  },
  CFR: {
    full: "Cost and Freight",
    mode: "Sea / inland waterway",
    summary:
      "Seller pays the freight to the destination port but risk transfers to the buyer once goods cross the ship's rail at origin. Buyer needs their own marine cargo insurance.",
  },
  CIF: {
    full: "Cost, Insurance & Freight",
    mode: "Sea / inland waterway",
    summary:
      "Like CFR but seller also buys minimum marine insurance in the buyer's name. Risk still transfers at origin (on board). Common for ocean shipments to buyers without freight expertise.",
  },
  CPT: {
    full: "Carriage Paid To",
    mode: "Any mode",
    summary:
      "Seller pays freight to the named destination. Risk transfers to buyer when goods are handed to the first carrier (not at destination). Multi-modal equivalent of CFR.",
  },
  CIP: {
    full: "Carriage and Insurance Paid To",
    mode: "Any mode",
    summary:
      "Same as CPT but seller also pays for all-risks cargo insurance to the destination. Multi-modal equivalent of CIF. Risk transfers at first carrier.",
  },
  DAP: {
    full: "Delivered at Place",
    mode: "Any mode",
    summary:
      "Seller delivers ready for unloading at a named place in the buyer's country. Seller bears all freight + risk to that point. Buyer handles import clearance and unloading.",
  },
  DPU: {
    full: "Delivered at Place Unloaded",
    mode: "Any mode",
    summary:
      "Seller delivers and UNLOADS at the named place. Seller bears all freight, risk, and unloading. Buyer handles import clearance. The only term where seller must unload.",
  },
  DDP: {
    full: "Delivered Duty Paid",
    mode: "Any mode",
    summary:
      "Seller bears every cost and risk all the way to the buyer's door, including import duties, taxes, and customs clearance. Maximum service from seller, simplest for buyer.",
  },
};

export const CURRENCY_OPTIONS = [
  "USD",
  "CAD",
  "EUR",
  "CNY",
  "GBP",
  "JPY",
  "MXN",
  "HKD",
] as const;

// Quote-comparison scoring weights. Lower-is-better on each axis;
// "landed cost" dominates but a fast lead time and big-enough stock break
// ties. Tweak per buyer preference later.
export const COMPARE_WEIGHTS = {
  landedUnitCost: 0.55,
  leadTimeDays: 0.25,
  stockCoverage: 0.10,
  validityRemaining: 0.05,
  starredSupplier: 0.05,
} as const;

export function fmtMoney(n: number, currency: string): string {
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: n >= 100 ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

// Returns a short status pill descriptor for an RfqRecipient (the row in
// the recipients table). Used in the buyer-side RFQ detail view.
export function describeRecipient(
  r: RfqRecipient,
): { label: string; color: string } {
  return QUOTE_STATUS_META[r.status];
}

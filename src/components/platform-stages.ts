// Stage metadata for the CADuniQ platform map. Pure data + types, no React,
// no client-only APIs — so server components (ComingSoonModule, every Coming
// Soon page) can import `getStage` without crossing the client/server
// boundary into PlatformMap.tsx (which is "use client").

export type PlatformStageId =
  | "stage-1"
  | "stage-2"
  | "stage-3"
  | "stage-4"
  | "stage-5"
  | "stage-6";

export type Stage = {
  id: PlatformStageId;
  badge: string;
  title: string;
  href?: string;
  status: "live" | "coming-soon" | "future";
  summary: string;
  modules: string[];
  emits?: string[];
  consumes?: string[];
  accent: string;
  accentBg: string;
  accentBorder: string;
};

export const STAGES: Stage[] = [
  {
    id: "stage-1",
    badge: "Stage 1 · M1-M26",
    title: "Software",
    href: "/design-engineering/software",
    status: "coming-soon",
    summary:
      "CAD model → manufacturable engineering package (drawings, BOM, AI manuals, FEA, AI tools).",
    modules: [
      "1a Single-Part 3D→2D MVP",
      "1b Assemblies + BOM",
      "1c AI Installation Manuals",
      "1d Engineering Toolkit (14 modules)",
      "1e AI Tools (Copilot, Chatbot, DFM)",
      "1f PDM-Lite",
      "1g Browser CAD + Text-to-CAD",
      "1h FEA & CFD Validation",
      "1i Marketing Renders",
      "1j Cross-CAD Plugins",
    ],
    emits: ["cad.uploaded", "bom.line.added", "design.approved"],
    accent: "#2563eb",
    accentBg: "#eff6ff",
    accentBorder: "#bfdbfe",
  },
  {
    id: "stage-2",
    badge: "Stage 2 · M5-M30",
    title: "Supplier Network",
    status: "future",
    summary:
      "Sourcing engine + Paperless-Parts-class quoting (anonymity pipeline, escrow, white-label).",
    modules: [
      "2a-2j Supplier DB / Routing / Anonymity / Quoting / Orders / Compliance",
      "2l White-Label Quote Engine",
      "2m Buyer Experience Portal",
    ],
    emits: ["quote.generated", "order.placed", "order.shipped"],
    consumes: ["design.approved"],
    accent: "#7c3aed",
    accentBg: "#faf5ff",
    accentBorder: "#ddd6fe",
  },
  {
    id: "stage-3",
    badge: "Stage 3 · M31-M48",
    title: "ERP System",
    href: "/suppliers",
    status: "live",
    summary:
      "Hub ops + design-driven ERP. Inventory, MRP, production planning, finance — all driven by the CAD.",
    modules: [
      "3a Hub Operations (QC, kitting, ship) — LIVE",
      "3b Inventory Ledger & WMS",
      "3c Procurement & MRP (auto-PO)",
      "3d Production Planning",
      "3e Finance & Accounting",
      "3f Reporting & Analytics",
      "3g Public API + ERP Connectors",
    ],
    emits: ["hub.qc.pass", "inventory.received", "invoice.issued"],
    consumes: ["bom.line.added", "design.approved", "order.shipped"],
    accent: "#16a34a",
    accentBg: "#f0fdf4",
    accentBorder: "#bbf7d0",
  },
  {
    id: "stage-4",
    badge: "Stage 4 · M28-M48",
    title: "CRM & Customer Lifecycle",
    href: "/crm",
    status: "coming-soon",
    summary:
      "Product-led CRM that listens to the event bus. Replaces Salesforce + HubSpot + Zendesk + Marketo.",
    modules: [
      "4a Accounts & Contacts",
      "4b Opportunity & Pipeline",
      "4c Quote Lifecycle",
      "4d Activity Timeline",
      "4e Customer Health Scoring",
      "4f Support Ticketing",
      "4g AI Chatbot (per-customer)",
      "4h Marketing Automation",
      "4i Sales Forecasting",
      "4j White-Label CRM",
      "4k External CRM Connectors",
    ],
    emits: ["opportunity.advanced", "ticket.opened", "crm.health.dropped"],
    consumes: [
      "cad.uploaded",
      "quote.accepted",
      "order.shipped",
      "hub.qc.fail",
      "oee.alert.raised",
    ],
    accent: "#db2777",
    accentBg: "#fdf2f8",
    accentBorder: "#fbcfe8",
  },
  {
    id: "stage-5",
    badge: "Stage 5 · M30-M60",
    title: "Full CAD + Enterprise PDM",
    href: "/design-engineering/full-cad",
    status: "coming-soon",
    summary:
      "SolidWorks-class CAD, browser-native (surfacing, CAM, electrical, routing) + cross-vendor PDM.",
    modules: [
      "5a Surfacing & Class-A (NURBS)",
      "5b Sheet Metal & Weldments Pro",
      "5c Mold Tools & Plastics",
      "5d Routing (Electrical/Piping/Conduit)",
      "5e CAM Toolpath",
      "5f Electrical Schematics 2D + 3D",
      "5g Composer-Grade Tech Comm",
      "5h Cross-CAD Round-Trip",
      "5i Enterprise PDM",
      "5j Desktop Bridge Apps",
    ],
    emits: [
      "cad.surface.modified",
      "cam.toolpath_generated",
      "pdm.eco_approved",
    ],
    consumes: ["cad.uploaded", "design.approved"],
    accent: "#ea580c",
    accentBg: "#fff7ed",
    accentBorder: "#fed7aa",
  },
  {
    id: "stage-6",
    badge: "Stage 6 · M60-M90",
    title: "Customer Floor Ops + Digital Twin",
    href: "/oee",
    status: "coming-soon",
    summary:
      "Real-time OEE + facility digital twin + field service. Genius / Prevu3D / TEEPTRAK in one platform.",
    modules: [
      "6a Real-Time OEE (TEEPTRAK-class)",
      "6b Facility Digital Twin (Prevu3D-class)",
      "6c Field Service & Maintenance",
      "6d IoT Sensor Network",
      "6e Quality / NCR / CAR",
      "6f ML Anomaly Detection",
      "6g VR / AR Training",
      "6h Customer Self-Service Hub",
      "6i Project Portfolio Management",
      "6j Plant Layout & Simulation",
    ],
    emits: ["oee.alert.raised", "asset.failure", "field.service.scheduled"],
    consumes: ["pdm.eco_approved", "order.shipped"],
    accent: "#0891b2",
    accentBg: "#ecfeff",
    accentBorder: "#a5f3fc",
  },
];

export function getStage(id: PlatformStageId): Stage {
  const s = STAGES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown stage: ${id}`);
  return s;
}

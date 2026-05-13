"use client";

// Inventory & Manufacturing — top-level container that wraps the existing
// supplier-management view as one sub-tab and surfaces stub tabs for the
// rest of the Odoo-style modules being built out.
// Visuals follow docs/superpowers/specs/2026-05-05-saas-dashboard-design-system.md.

import { useState } from "react";
import SuppliersView from "./SuppliersView";
import BarcodeGenerator from "./BarcodeGenerator";
import StubTab from "./StubTab";
import type {
  Supplier,
  SupplierProjectEntry,
  SupplierComment,
  SupplierAttachment,
} from "@/db/schema";

type FullSupplier = Supplier & {
  projectEntries: SupplierProjectEntry[];
  comments: SupplierComment[];
  attachments: SupplierAttachment[];
};

const SUB_TABS = [
  { key: "suppliers", label: "Suppliers" },
  { key: "inventory", label: "Inventory" },
  { key: "purchase-orders", label: "Purchase Orders" },
  { key: "manufacturing", label: "Manufacturing" },
  { key: "boms", label: "BOMs" },
  { key: "quality", label: "Quality" },
  { key: "maintenance", label: "Maintenance" },
  { key: "barcodes", label: "Barcodes" },
] as const;
type TabKey = (typeof SUB_TABS)[number]["key"];

export default function InventoryAndManufacturing({
  initialData,
  canEdit,
}: {
  initialData: FullSupplier[];
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("suppliers");

  return (
    <div className="flex flex-col min-h-full" style={{ background: "var(--lb-bg)" }}>
      <nav
        role="tablist"
        aria-label="ERP System modules"
        className="flex items-center gap-2 px-6 py-3 shrink-0 overflow-x-auto"
        style={{
          background: "var(--lb-bg)",
          borderBottom: "1px solid var(--lb-border)",
        }}
      >
        {SUB_TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "0 16px",
                height: 36,
                borderRadius: "var(--lb-radius-pill)",
                fontSize: "var(--lb-text-13)",
                fontWeight: active ? 600 : 500,
                letterSpacing: "-0.005em",
                color: active ? "var(--lb-accent-fg)" : "var(--lb-text-2)",
                background: active ? "var(--lb-accent)" : "var(--lb-bg-elev)",
                border: active
                  ? "1px solid var(--lb-accent)"
                  : "1px solid var(--lb-border)",
                whiteSpace: "nowrap",
                cursor: "pointer",
                transition:
                  "background 160ms ease, color 160ms ease, border-color 160ms ease",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      <main className="flex-1">
        {tab === "suppliers" && (
          <SuppliersView initialData={initialData} canEdit={canEdit} />
        )}
        {tab === "barcodes" && <BarcodeGenerator canEdit={canEdit} />}
        {tab === "inventory" && (
          <StubTab
            title="Inventory"
            description="Track stock levels, locations, transfers, and lot/serial numbers."
            features={[
              "Stock items with SKU + barcode + variant model",
              "Multi-warehouse / multi-location tracking",
              "Stock moves (transfers, receipts, deliveries)",
              "Lot / serial number traceability",
              "Adjustments + scrap + cycle counts",
              "Reorder rules (min/max stock per location)",
              "Mobile-friendly receive / pick / pack flow with barcode scanning",
            ]}
          />
        )}
        {tab === "purchase-orders" && (
          <StubTab
            title="Purchase Orders"
            description="Multi-PO per project, tracking, and shipping documents."
            features={[
              "Multiple POs per project (request another order anytime)",
              "Tracking number + carrier + person in charge",
              "Document attachments: Proforma Invoice, Bill of Lading, Packing List, Commercial Invoice",
              "PO state machine: draft → confirmed → in-transit → received → closed",
              "Three-way match (PO ↔ receipt ↔ vendor invoice)",
              "Tenders / RFQs with vendor comparison",
              "Blanket orders + price agreements",
            ]}
          />
        )}
        {tab === "manufacturing" && (
          <StubTab
            title="Manufacturing Orders"
            description="Production orders, work orders, routings, and shop-floor execution."
            features={[
              "MO from sales order or stock rule",
              "Work orders per BOM operation",
              "Real-time component consumption + finished-good production",
              "Workcenter capacity + scheduling",
              "Time tracking + OEE per workcenter",
              "Subcontracting (outsource a routing to a partner)",
              "Mobile shop-floor app: scan to start / stop / consume / produce",
            ]}
          />
        )}
        {tab === "boms" && (
          <StubTab
            title="Bills of Materials"
            description="Multi-level BOMs with versions, kits, and PLM-style change control."
            features={[
              "Multi-level BOM (parents + sub-assemblies)",
              "Variants — one BOM, many SKU configurations",
              "Phantom BOMs (kits)",
              "By-products (scrap or co-products)",
              "BOM operations + work-center routings",
              "PLM: ECO change orders, version history, redlines",
              "Engineering vs production BOM split",
            ]}
          />
        )}
        {tab === "quality" && (
          <StubTab
            title="Quality"
            description="QC inspections, returns, claims, and warranty tracking — connected to projects."
            features={[
              "QC checks per project: upload photos, log measurements, pass/fail",
              "Quality alerts + 8D / CAPA workflow",
              "Returns + claims log linked to PO / MO / project",
              "Warranty policies (basic per business + per-product overrides)",
              "Return & exchange policies (per business + per-product)",
              "Defect rate dashboards (vendor, product, period)",
              "Photographic evidence retained per project for traceability",
              "Packaging specifications: labelling on product / instruction page / box",
            ]}
          />
        )}
        {tab === "maintenance" && (
          <StubTab
            title="Maintenance"
            description="Preventive + corrective maintenance for equipment and tooling."
            features={[
              "Equipment registry with photos + serials",
              "Preventive schedule (calendar / runtime / counter)",
              "Corrective tickets from shop-floor request",
              "MTBF / MTTR metrics per asset",
              "Spare parts BOM per equipment",
              "Calibration logs (precision tools / measurement gauges)",
              "QR code on each asset → scan opens its record",
            ]}
          />
        )}
      </main>
    </div>
  );
}

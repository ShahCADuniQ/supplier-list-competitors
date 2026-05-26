"use client";

// Inventory & Manufacturing — top-level container that wraps the existing
// supplier-management view as one sub-tab and surfaces stub tabs for the
// rest of the Odoo-style modules being built out.
// Visuals follow docs/superpowers/specs/2026-05-05-saas-dashboard-design-system.md.

import { useState } from "react";
import SuppliersView from "./SuppliersView";
import BarcodeGenerator from "./BarcodeGenerator";
import StubTab from "./StubTab";
import OrdersTab from "./OrdersTab";
import InventoryTab from "./InventoryTab";
import OnboardingReviewPanel from "./OnboardingReviewPanel";
import SupplierInventoryOverview from "./SupplierInventoryOverview";
// SupplierInventoryTab is no longer rendered as its own top-level tab.
// Its content (SupplierCatalogView) is now embedded inside each
// supplier's detail panel in SuppliersView, so you click into a
// supplier and use the new "Inventory" tab there.
import type {
  Supplier,
  SupplierAttachment,
  SupplierComment,
  SupplierContact,
  SupplierProjectEntry,
} from "@/db/schema";

type FullSupplier = Supplier & {
  projectEntries: SupplierProjectEntry[];
  comments: SupplierComment[];
  attachments: SupplierAttachment[];
  contacts: SupplierContact[];
};

const SUB_TABS = [
  { key: "onboarding-requests", label: "Onboarding Request" },
  { key: "suppliers", label: "Suppliers" },
  { key: "orders", label: "Orders (RFQ & PO)" },
  // Per-supplier catalog still lives inside each supplier's detail panel
  // (the "Products" tab there). This top-level "Supplier Inventory" is
  // the cross-supplier overview that replaced the old Manufacturing
  // stub — every part across every supplier in the tenant, with project
  // / product filters.
  { key: "inventory", label: "Lightbase Inventory" },
  { key: "supplier-inventory", label: "Supplier Catalogue" },
  { key: "boms", label: "BOMs" },
  { key: "quality", label: "Quality" },
  { key: "maintenance", label: "Maintenance" },
  { key: "barcodes", label: "Barcodes" },
] as const;
type TabKey = (typeof SUB_TABS)[number]["key"];

export default function InventoryAndManufacturing({
  initialData,
  canEdit,
  registeredSupplierIds = [],
}: {
  initialData: FullSupplier[];
  canEdit: boolean;
  // Supplier ids whose email matches a user_profiles row with
  // is_supplier=true — i.e. the supplier has signed up to the vendor
  // portal and gone through onboarding. Drives the "Registered
  // suppliers" pill on the suppliers tab.
  registeredSupplierIds?: number[];
}) {
  // Every tenant member with supplier-view access (canViewSuppliers
  // OR role='admin') can approve / reject / merge — the server-side
  // gate is requireSupplierReviewer, not requireSupplierEditor — so
  // we surface the Onboarding Request tab to everyone who reaches
  // this page.
  const [tab, setTab] = useState<TabKey>("onboarding-requests");

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
        {tab === "onboarding-requests" && (
          <div style={{ padding: 24, background: "var(--lb-bg)", minHeight: "100%" }}>
            {/* canEdit is forced ON because every tenant member can
                review (server-side gate is requireSupplierReviewer).
                The prop name is legacy; it just toggles the action
                buttons inside the panel. */}
            <OnboardingReviewPanel canEdit={true} />
          </div>
        )}
        {tab === "suppliers" && (
          <SuppliersView
            initialData={initialData}
            canEdit={canEdit}
            registeredSupplierIds={registeredSupplierIds}
          />
        )}
        {tab === "barcodes" && <BarcodeGenerator canEdit={canEdit} />}
        {tab === "inventory" && <InventoryTab canEdit={canEdit} />}
        {tab === "orders" && (
          <OrdersTab suppliers={initialData} canEdit={canEdit} />
        )}
        {tab === "supplier-inventory" && (
          <SupplierInventoryOverview canEdit={canEdit} />
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

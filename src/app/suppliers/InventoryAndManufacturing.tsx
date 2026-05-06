"use client";

// Inventory & Manufacturing — top-level container that wraps the existing
// supplier-management view as one sub-tab and surfaces stub tabs for the
// rest of the Odoo-style modules being built out (Inventory, POs, MOs,
// BOMs, Quality, Maintenance, Barcodes).
//
// Phase 1 (today):
//   • Suppliers — fully functional (existing UI)
//   • Barcodes — generate Code128 / QR codes for any item, print sheets
//
// Phase 2+ (roadmap):
//   • Inventory — stock items + locations + transfers
//   • Purchase Orders — multi-PO per project, tracking #, PI/BoL/CI docs
//   • Manufacturing Orders + BOMs — production routings
//   • Quality — QC photos per project, returns + claims log
//   • Maintenance — equipment maintenance schedules
//   • PLM — product lifecycle management
// See ROADMAP-INVENTORY.md for full details.

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
  { key: "suppliers", label: "Suppliers", icon: "🏭" },
  { key: "inventory", label: "Inventory", icon: "📦" },
  { key: "purchase-orders", label: "Purchase Orders", icon: "🧾" },
  { key: "manufacturing", label: "Manufacturing", icon: "⚙️" },
  { key: "boms", label: "BOMs", icon: "📋" },
  { key: "quality", label: "Quality", icon: "✅" },
  { key: "maintenance", label: "Maintenance", icon: "🔧" },
  { key: "barcodes", label: "Barcodes", icon: "📊" },
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
    <div className="im-app">
      <header className="im-header">
        <div className="im-hero">
          <p className="im-eyebrow">Operations</p>
          <h1 className="im-h1">Inventory &amp; Manufacturing.</h1>
          <p className="im-subtitle">
            Stock, production, purchasing, quality, maintenance, and suppliers —
            <br className="im-br" />
            unified, beautifully.
          </p>
        </div>
        <nav className="im-tabs" role="tablist" aria-label="Module sub-tabs">
          {SUB_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`im-tab${tab === t.key ? " im-tab-active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              <span className="im-tab-icon" aria-hidden>{t.icon}</span>
              <span className="im-tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
      </header>

      <main className="im-main">
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

      <style>{`
        .im-app{min-height:100%;background:var(--lb-bg);color:var(--lb-text)}

        .im-header{
          padding:0;
          background:var(--lb-bg);
          border-bottom:1px solid var(--lb-border);
        }

        .im-hero{padding:64px 32px 40px;text-align:center;max-width:1200px;margin:0 auto}
        .im-eyebrow{
          font-family:var(--lb-font-display);
          font-size:13px;font-weight:600;color:var(--lb-accent);
          letter-spacing:.02em;margin:0 0 12px;text-transform:none;
        }
        .im-h1{
          font-family:var(--lb-font-display);
          font-size:clamp(40px,5.6vw,68px);
          line-height:1.05;font-weight:600;
          letter-spacing:-.03em;
          margin:0;color:var(--lb-text);
        }
        .im-subtitle{
          font-family:var(--lb-font-text);
          font-size:clamp(17px,1.6vw,21px);
          line-height:1.45;font-weight:400;letter-spacing:-.01em;
          color:var(--lb-text-2);margin:18px auto 0;max-width:640px;
        }

        .im-tabs{
          display:flex;gap:2px;
          padding:0 16px 14px;
          margin:18px auto 0;max-width:1200px;
          overflow-x:auto;-webkit-overflow-scrolling:touch;
          scrollbar-width:none;
          justify-content:center;
          mask-image:linear-gradient(90deg,transparent,#000 12px,#000 calc(100% - 12px),transparent);
        }
        .im-tabs::-webkit-scrollbar{display:none}
        .im-tab{
          display:inline-flex;align-items:center;gap:6px;
          padding:8px 14px;border:none;background:transparent;
          color:var(--lb-text-2);font-family:var(--lb-font-text);
          font-size:13px;font-weight:500;letter-spacing:-.005em;white-space:nowrap;
          cursor:pointer;border-radius:var(--lb-radius-pill);
          transition:color .2s ease,background .2s ease,transform .1s ease;
        }
        .im-tab:hover{color:var(--lb-text);background:color-mix(in srgb,var(--lb-text) 5%,transparent)}
        .im-tab:active{transform:scale(.97)}
        .im-tab-active{color:#fff;background:var(--lb-text);font-weight:500}
        .im-tab-active:hover{color:#fff;background:var(--lb-text)}
        .im-tab-icon{font-size:14px;line-height:1;opacity:.85}
        .im-tab-label{line-height:1}

        .im-main{padding:0}

        @media (max-width:768px){
          .im-hero{padding:36px 20px 24px;text-align:left}
          .im-h1{font-size:34px;line-height:1.1}
          .im-subtitle{font-size:16px;margin-top:12px;text-align:left}
          .im-br{display:none}
          .im-tabs{justify-content:flex-start;padding:0 16px 12px;margin-top:12px}
        }
      `}</style>
    </div>
  );
}

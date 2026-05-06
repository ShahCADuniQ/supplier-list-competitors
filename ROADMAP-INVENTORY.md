# Inventory & Manufacturing — Roadmap

A staged plan for building the full Odoo-style Inventory + Manufacturing
suite inside Lightbase, tailored for the lighting industry. Each phase
is shippable on its own; stakeholders see real value at every step
instead of waiting for a months-long monolith.

---

## Phase 1 — Foundation (shipped 2026-05-04)

- ✅ Top-nav: **Inventory & Manufacturing** replaces *Suppliers*
- ✅ Sub-tab shell with all module placeholders visible from day one
- ✅ **Suppliers** sub-tab — full existing supplier-management UI
- ✅ **Barcodes** — generate Code 128 / EAN-13 / QR for any value
  - Single value, paste-list, or auto-sequence (`PREFIX-0001…`)
  - Live preview, single-PNG download, multi-label print sheet
  - Layouts: Avery 5160 (3×10), 2×7 shipping, 4×12 dense
- ✅ Mobile-responsive sub-tab nav (horizontal scroll on phone)
- ✅ Roadmap doc (this file) covering Phases 2–4

---

## Phase 2 — Stock & Purchasing (next)

### 2.1 Inventory module
- Stock items: SKU, barcode, variant model, photos, dimensions, weight
- Multi-warehouse / multi-location with bin-level granularity
- Stock moves: receipts, deliveries, transfers, scrap, adjustments
- Lot / serial number traceability (forward + backward)
- Reorder rules per location (min / max / order quantity)
- Mobile receive flow: scan barcode → enter qty → done
- Mobile pick flow: pick list → scan to confirm → pack

### 2.2 Purchase Orders module
Built around the user's specific lighting-industry needs:
- **Multiple POs per project** — request another order any time
- Each PO carries: vendor, tracking #, carrier, person in charge,
  dates (ordered, expected, received)
- Document attachments: **PI** (Proforma Invoice), **BoL** (Bill of
  Lading), **Packing List**, **CI** (Commercial Invoice)
- PO state machine: `draft → confirmed → in-transit → received → closed`
- Three-way match (PO ↔ receipt ↔ vendor invoice)
- Tenders / RFQs with side-by-side vendor comparison
- Blanket orders + price agreements

### 2.3 Schema scaffolding
```
stock_items            (id, sku, barcode, name, variant_model, ...)
stock_locations        (id, warehouse_id, code, name, parent_id)
stock_moves            (id, item_id, qty, from_loc, to_loc, lot, ...)
purchase_orders        (id, project_id, supplier_id, state, tracking_no,
                        carrier, person_in_charge, ordered_at, expected_at,
                        received_at, total)
po_lines               (id, po_id, item_id, qty, unit_price)
po_documents           (id, po_id, kind: pi|bol|packing|ci|other, blob_url)
```

---

## Phase 3 — Manufacturing & BOMs

### 3.1 Bills of Materials
- Multi-level BOMs (parents + sub-assemblies)
- Variants — one BOM, many SKU configurations
- Phantom BOMs (kits)
- By-products (scrap or co-products)
- BOM operations + work-center routings
- Engineering BOM vs production BOM split

### 3.2 Manufacturing Orders
- MO from sales order or stock rule
- Work orders per BOM operation
- Real-time component consumption + finished-good production
- Workcenter capacity + scheduling
- Time tracking + OEE per workcenter
- Subcontracting (outsource a routing to a partner)
- **Mobile shop-floor app**: scan to start / stop / consume / produce

### 3.3 PLM (Product Lifecycle Management)
- ECO change orders with approver workflow
- BOM version history with redlines
- Engineering vs production BOM separation
- Document attachments per part (CAD, datasheet, photometric file)

---

## Phase 4 — Quality & Maintenance

### 4.1 Quality module — the lighting-industry focus
- **QC checks per project**: upload photos, log measurements, pass/fail
- **Returns + claims log** linked to PO / MO / project
- **Warranty policies** — basic per business + per-product overrides
- **Return & exchange policies** — per business + per-product
- Quality alerts + 8D / CAPA workflow
- Defect rate dashboards (vendor / product / period)
- **Photographic evidence retained per project** — full traceability
- **Packaging specifications** — labelling on product / instruction
  page / box (linked to barcode generator from Phase 1)

### 4.2 Maintenance module
- Equipment registry with photos + serials
- Preventive schedule (calendar / runtime / counter-based)
- Corrective tickets from shop-floor request
- MTBF / MTTR metrics per asset
- Spare parts BOM per equipment
- Calibration logs (precision tools / measurement gauges)
- **QR code on each asset → scan opens its record** (uses Phase 1 generator)

---

## Cross-cutting concerns (apply to every phase)

- **Mobile-first**: every feature must be usable from a phone with one
  hand. Targets ≥ 44 px. Forms reflowable. Barcode scanning always
  available via device camera.
- **Permissions**: scope to existing `canViewSuppliers` / `canEdit`
  helpers; expand as needed.
- **Audit trail**: every state change captured with actor + timestamp.
- **Connected**: items, POs, MOs, projects, suppliers, and quality
  records are all linkable. From any record, jump to related ones.
- **Document attachments**: Vercel Blob, with previews where possible.
- **AI assist**: where it makes sense (auto-fill PI from PDF, suggest
  reorder qty from history, surface anomalies in QC photos).

---

## What's intentionally NOT here yet

Items the user mentioned only in passing or that need more discovery
before scope-locking:

- Forecasting / MRP (Phase 5 candidate)
- E-commerce sync, dropshipping, EDI
- Fleet / transport management
- Multi-currency landed cost calculations

These will get their own design pass once Phases 2–4 are running and we
have real usage data.

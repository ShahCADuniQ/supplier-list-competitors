# Supplier Catalogue: Add Product + Primary-scope Fix

**Date:** 2026-06-08
**Surface:** ERP → Inventory & Manufacturing → Supplier Catalogue tab
**Status:** Approved verbally; proceed to plan & implementation.

## Goal

Two related changes on the Supplier Catalogue overview:

1. **Make the "Primary only" scope toggle behave the way users expect** (currently has a vanishing-cluster bug and a misleading label).
2. **Add the ability to create products directly from the Supplier Catalogue**, with two modes:
   - **AI-assisted** (paste a URL → Perplexity fetches + reads the page → Claude extracts structured product data → images downloaded to blob → product card auto-filled, configurations included if the page has variants).
   - **Manual** (form entry).

Both modes must also (a) resolve the **supplier** automatically (match an existing supplier or create a new one inline), and (b) **detect when the product already exists** in the catalogue (by product code) and offer to link it as an alternative supplier on the existing cluster rather than creating a duplicate standalone row.

## Part A — Scope toggle fix

### Current behaviour

`src/app/suppliers/SupplierInventoryOverview.tsx:36, 73-76`. The scope state holds `"all" | "primary"`. In `"primary"` mode the filter drops rows that are in a multi-product cluster and aren't marked primary. Standalone products always show.

### Problems

1. **Vanishing cluster bug.** If a cluster has 2+ rows but none of them is marked primary, *every row in that cluster* is filtered out. The whole cluster disappears from the overview in "Primary only" mode.
2. **Misleading label.** "Primary only" reads like "rows where `isPrimarySupplier = true`", but the implementation is actually "deduplicated canonical row per product."

### Fix

- Rename pills to **"All products"** and **"One per product"** (the second pill keeps the green star icon).
- Re-implement the filter as a true deduplication:
  - Group `parts` by `globalProductId` (rows with a null `globalProductId` are their own group of one).
  - For each group, pick exactly one representative row to show: the row with `isPrimarySupplier = true` if one exists, otherwise the row with the most recent `updatedAt`.
  - In "All products" mode, no grouping — return every row unchanged.
- Empty-state copy and the count badge stay; only the filter logic changes.

## Part B — Add product flow

### Affordance

- New header button **"+ Add product"** in `SupplierInventoryOverview.tsx`, placed next to the scope-toggle pills.
- Clicking opens a dialog with two tabs: **From URL** (default) and **Manual**.
- If the catalogue's supplier filter is set to a specific supplier, that supplier is pre-selected in the Manual tab and pre-filled as a hint in the From URL tab.

### Tab 1 — From URL (AI-assisted)

Inputs:
- Product URL (required)
- Supplier hint (optional, free text — e.g. "this is Asahi")
- Category hint (optional dropdown from `SUPPLIER_CATEGORIES`)
- File drop (optional — PDFs / images attached after the product is created)

Submit posts to a new SSE endpoint **`POST /api/suppliers/add-product`** modeled directly on the existing `/api/competitors/add-product`. Pipeline:

1. **fetch** the page (HTML). If essentially empty → **headless render** via Playwright (already in deps).
2. **Perplexity** is asked to read the page and return structured content.
3. **Claude** extracts a product card matching the schema below.
4. **Image discovery** + download to Vercel Blob.
5. **Supplier resolution** (see below).
6. **Existing-product detection** (see below).
7. **DB write** — insert `supplier_products` row, plus one `supplier_products` row per detected configuration (nested via `parent_product_id`).
8. **Attach** any user-uploaded files via `supplier_product_attachments`.

Each step emits an SSE event for the live progress UI. Reuse the competitors' `_progress.tsx` (`ProgressPanel`, `consumeSseStream`, `formatDuration`) without modification.

#### Extraction schema (from Claude)

```ts
{
  name: string;                        // required
  productCode: string | null;
  category: string | null;             // snapped to SUPPLIER_CATEGORIES
  description: string | null;
  thumbnailUrl: string | null;         // a discovered image URL, downloaded to blob in step 4
  imageUrls: string[];                 // additional images, attached as files
  supplierName: string | null;         // brand/manufacturer name
  supplierWebsite: string | null;
  supplierEmail: string | null;        // if visible on page
  configurations: Array<{              // empty array if none detected
    name: string;
    productCode: string | null;
    description: string | null;
  }>;
}
```

### Tab 2 — Manual

Pure form, same shell:
- **Supplier picker** — searchable dropdown over existing tenant suppliers. Bottom row of the dropdown is **"+ Create new supplier"** which opens a small inline sub-dialog (name, email, website, origin). On save the new supplier appears in the picker, pre-selected.
- Name (required), Product code, Category (`SUPPLIER_CATEGORIES`), Description.
- Optional thumbnail upload.

Same existing-product detection on save (Part B's match step).

### Supplier resolution (automatic)

Used by Tab 1 only; Tab 2 is explicit.

1. **Match against existing tenant suppliers** in this order:
   - Domain match: extract domain from `supplierWebsite`, compare case-insensitive against each supplier's website.
   - Name match: case-insensitive, trimmed `supplierName` equals an existing `suppliers.name`.
   - Hint match: if the user provided a supplier hint, fuzzy-contains against `suppliers.name`.
2. **No match** → create a new `suppliers` row using extracted `supplierName`, `supplierWebsite`, `supplierEmail`, with tenant `clientId` set to the active user's tenant.
3. The resolved supplier is shown in the progress panel before final commit so the user can override ("Pick a different supplier") if the auto-pick is wrong.

### Existing-product detection (auto-link as alternative)

Used by both tabs on save.

1. Look up existing top-level `supplier_products` rows in this tenant where `LOWER(TRIM(product_code)) = LOWER(TRIM(new.product_code))`. Only consider rows where `product_code` is non-null/non-empty.
2. **One or more matches** → the server's SSE stream emits a `match-detected` event carrying the candidate cluster's `globalProductId` and the supplier names, then **pauses**. The client renders a confirmation panel: *"Code `{code}` already exists under {SupplierA, SupplierB}. Link this new entry as an alternative supplier for that cluster?"*. The user picks **Link** or **Keep separate**, and the client POSTs the decision back to the SSE endpoint (resume path), which finishes the write:
   - **Link** → the new row is created with `globalProductId = matched.globalProductId`, `isPrimarySupplier = false`. The cluster's existing primary (if any) stays primary.
   - **Keep separate** → the new row gets its own fresh `globalProductId` (current behaviour).
3. **No match** → no pause, no prompt, fresh `globalProductId`.

Supplier resolution uses the same pause-and-confirm protocol when the auto-pick is uncertain (e.g. multiple suppliers matched, or no match found but the user supplied a hint) — single SSE event `supplier-resolved` carrying the proposed supplier (or "create new with this data"), with an inline override option.

### Configurations

If `configurations[]` from extraction is non-empty, each entry is created as a `supplier_products` row with `parent_product_id` pointing at the just-created top-level part. Per existing convention, each config row gets its own fresh `globalProductId`.

Manual tab does **not** offer inline config entry — that stays in the part's drawer (existing flow). Manual tab only creates the top-level part.

## Part C — Reused infrastructure

- `src/lib/ai/perplexity.ts`, `src/lib/ai/claude.ts`, `src/lib/ai/extract.ts`, `src/lib/ai/render.ts` — reused as-is.
- `src/app/competitors/_progress.tsx` and the SSE consumer pattern — reused. If shared with the new suppliers SSE endpoint becomes painful, factor into `src/lib/ai-add-progress/` later; not blocking.
- Vercel Blob client-side upload for the optional file drop.
- No schema migrations: `supplierProducts`, `suppliers`, `supplierProductAttachments` are sufficient.

## Out of scope (explicitly)

- Strict "show only `isPrimarySupplier = true`" mode. Not what the user wanted.
- Bulk add (paste many URLs at once). Single product per submission.
- Editing a product via AI fill (apply Perplexity/Claude to an existing card). Maybe later.
- New-supplier creation from inside Tab 1's mid-flow override. (Override is a "pick a different existing supplier" picker only; if none of the existing ones fit, user cancels and uses Tab 2.)

## Decisions log (from brainstorming)

- "+ Add product" affordance: header button, with auto-supplier-link or auto-create-supplier (user approved).
- Existing-product match key: `productCode` only, with explicit user confirmation before linking (user approved by saying "just make it happen" to a design that included this).
- Configurations from URL: nested under the new part automatically.
- Scope toggle: relabel + fix vanishing-cluster (not strict "only primary").

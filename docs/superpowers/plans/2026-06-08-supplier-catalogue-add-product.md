# Supplier Catalogue: Add Product + Primary-scope Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Supplier Catalogue overview, fix the "Primary only" scope-toggle (vanishing-cluster bug + misleading label) and add a "+ Add product" flow with two modes (AI-assisted from URL using Perplexity + Claude, or pure manual), including auto supplier link-or-create and existing-product cluster matching.

**Architecture:** Mirror the proven competitors `AddProductForm` + `/api/competitors/add-product` SSE pattern. Two endpoints: a streaming **extract** endpoint (Perplexity → Claude → match candidates) and a regular **commit** endpoint (the DB writes after the user confirms the supplier resolution and the existing-product link choice). Reuse `src/lib/ai/perplexity.ts`, `src/lib/ai/claude.ts`, `src/lib/ai/render.ts`, and `src/app/competitors/_progress.tsx` verbatim.

**Tech Stack:** Next.js 16 (App Router + Route Handlers), React 19, Clerk auth, Drizzle ORM on Postgres (Neon), Vercel Blob, Anthropic SDK (Claude), Perplexity REST API.

**Reference design:** `docs/superpowers/specs/2026-06-08-supplier-catalogue-add-product-design.md`

---

## File map

### Create
- `src/app/suppliers/add-product-actions.ts` — orchestration helpers for the add-product flow (extract from URL streaming + commit). Kept separate from `supplier-inventory-actions.ts` (already ~1900 lines).
- `src/app/api/suppliers/add-product/extract/route.ts` — POST SSE endpoint. Streams Perplexity + Claude extraction progress; final event carries `{ extraction, supplierMatch, productMatchCandidates }`.
- `src/app/api/suppliers/add-product/commit/route.ts` — POST endpoint. Persists the new product (and optionally a new supplier) using the user's confirmed choices; returns the new `partId`.
- `src/app/suppliers/AddProductDialog.tsx` — client dialog with two tabs (URL, Manual). Reuses `ProgressPanel` + `consumeSseStream` from `src/app/competitors/_progress.tsx`.
- `scripts/test-supplier-scope-filter.ts` — smoke script for the new scope filter pure function.
- `scripts/test-supplier-extract.ts` — smoke script that hits `extractSupplierProductFromUrl` against a real URL and prints the result. Lets us iterate on the Claude prompt without booting the full UI.

### Modify
- `src/app/suppliers/SupplierInventoryOverview.tsx` — relabel the scope-toggle pills, rewire the filter to a pure deduper, add the "+ Add product" header button, mount `AddProductDialog`.
- `src/lib/ai/extract.ts` — add `SupplierProductExtraction` type + `extractSupplierProductFromUrl(url, hint)` that calls Perplexity then Claude using the established pattern (see `extractSingleProduct` at line 717 for reference).
- `src/app/suppliers/supplier-inventory-actions.ts` — add three small server helpers consumed by the new endpoints: `findSuppliersForResolution(name, website)`, `findExistingProductsByCode(code)`, `createSupplierForExtraction(input)`. Keep them adjacent to the existing `createSupplierProduct`.

### Untouched
- `src/lib/ai/perplexity.ts`, `src/lib/ai/claude.ts`, `src/lib/ai/render.ts` — reused as-is.
- `src/app/competitors/_progress.tsx` — reused as-is (imported by `AddProductDialog`).
- `src/db/schema.ts` — no migrations required.

---

## Phase 1 — Scope toggle fix (Part A of spec)

Small, self-contained. Ship this first so the overview is clean before stacking the bigger Add Product surface on top.

### Task 1: Extract the scope filter as a pure function with a smoke script

**Files:**
- Create: `scripts/test-supplier-scope-filter.ts`
- Modify: `src/app/suppliers/SupplierInventoryOverview.tsx:66-98` (replace inline filter logic)

- [ ] **Step 1: Define the pure function inline above the component**

Add this above `export default function SupplierInventoryOverview` in `src/app/suppliers/SupplierInventoryOverview.tsx`:

```ts
// "all"           → every catalogue row, no dedup.
// "one-per-product" → exactly one row per cluster (rows sharing a globalProductId).
//                    Pick the row marked isPrimarySupplier; if none, pick the row
//                    with the most recent updatedAt. Rows with no globalProductId
//                    are their own cluster of one and always show.
export type SupplierCatalogueScope = "all" | "one-per-product";

export function dedupeParts<
  T extends {
    globalProductId: string | null;
    isPrimarySupplier: boolean;
    updatedAt: Date;
  },
>(parts: T[], scope: SupplierCatalogueScope): T[] {
  if (scope === "all") return parts;
  const groups = new Map<string, T[]>();
  const standalones: T[] = [];
  for (const p of parts) {
    if (!p.globalProductId) {
      standalones.push(p);
      continue;
    }
    const arr = groups.get(p.globalProductId) ?? [];
    arr.push(p);
    groups.set(p.globalProductId, arr);
  }
  const representatives: T[] = [];
  for (const rows of groups.values()) {
    const primary = rows.find((r) => r.isPrimarySupplier);
    if (primary) {
      representatives.push(primary);
      continue;
    }
    const sortedByRecent = [...rows].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    representatives.push(sortedByRecent[0]);
  }
  return [...standalones, ...representatives];
}
```

- [ ] **Step 2: Rewire the existing `filtered` useMemo to call `dedupeParts`**

Replace lines 66-98 in `SupplierInventoryOverview.tsx`:

```ts
const filtered = useMemo(() => {
  const q = search.trim().toLowerCase();
  const matchesFilters = (p: AggregateInventoryPart): boolean => {
    if (supplierFilter !== "all" && String(p.supplierId) !== supplierFilter) {
      return false;
    }
    if (projectFilter !== "all" && !p.projectNums.includes(projectFilter)) {
      return false;
    }
    if (partNameFilter !== "all" && p.name !== partNameFilter) {
      return false;
    }
    if (!q) return true;
    const hay = [
      p.name,
      p.productCode ?? "",
      p.category ?? "",
      p.description ?? "",
      p.supplierName,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  };
  // Dedup BEFORE field-filtering so the per-cluster representative is picked
  // from the full set, not from rows that happened to survive the supplier
  // filter. Otherwise selecting a supplier in the filter would skew which row
  // wins each cluster.
  const deduped = dedupeParts(data?.parts ?? [], scope);
  return deduped.filter(matchesFilters);
}, [data, search, projectFilter, supplierFilter, partNameFilter, scope]);
```

- [ ] **Step 3: Replace the `scope` state type**

Change line 36 in `SupplierInventoryOverview.tsx`:

```ts
const [scope, setScope] = useState<SupplierCatalogueScope>("all");
```

And update the reset button at line 301 to:

```ts
setScope("all");
```

- [ ] **Step 4: Write the smoke script**

Create `scripts/test-supplier-scope-filter.ts`:

```ts
// Quick smoke for dedupeParts. Run: npx tsx scripts/test-supplier-scope-filter.ts
import { dedupeParts } from "../src/app/suppliers/SupplierInventoryOverview";

type Row = {
  id: number;
  globalProductId: string | null;
  isPrimarySupplier: boolean;
  updatedAt: Date;
};

function row(
  id: number,
  globalProductId: string | null,
  isPrimarySupplier: boolean,
  updatedAt: Date,
): Row {
  return { id, globalProductId, isPrimarySupplier, updatedAt };
}

function expect(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) process.exitCode = 1;
}

const t0 = new Date("2026-01-01");
const t1 = new Date("2026-02-01");
const t2 = new Date("2026-03-01");

// Cluster with a primary
const r1 = row(1, "gp-a", false, t0);
const r2 = row(2, "gp-a", true, t1);
const r3 = row(3, "gp-a", false, t2);
// Cluster with NO primary — must still surface ONE row (most recent)
const r4 = row(4, "gp-b", false, t0);
const r5 = row(5, "gp-b", false, t2);
// Standalone (null globalProductId) — always shows
const r6 = row(6, null, false, t1);

const all = [r1, r2, r3, r4, r5, r6];
const dedupAll = dedupeParts(all, "all");
expect("all mode returns every row", dedupAll.length === 6);

const dedup1 = dedupeParts(all, "one-per-product");
const ids = dedup1.map((r) => r.id).sort((a, b) => a - b);
expect(
  `one-per-product picks primary for gp-a, most-recent for gp-b, keeps standalone — got ids ${ids.join(",")}`,
  ids.length === 3 && ids.includes(2) && ids.includes(5) && ids.includes(6),
);

const dedupEmpty = dedupeParts([], "one-per-product");
expect("empty input is empty output", dedupEmpty.length === 0);
```

- [ ] **Step 5: Export `dedupeParts` from the overview file**

Adjust line 19 of `SupplierInventoryOverview.tsx` (the existing `export default function`) — the function declaration above the component already uses `export function`. Verify the export is reachable:

```bash
npx tsx scripts/test-supplier-scope-filter.ts
```
Expected output: three `PASS` lines, zero `FAIL`.

- [ ] **Step 6: Commit**

```bash
git add scripts/test-supplier-scope-filter.ts src/app/suppliers/SupplierInventoryOverview.tsx
git commit -m "fix(suppliers): scope toggle dedupes properly, no vanishing clusters"
```

### Task 2: Relabel the scope toggle pills

**Files:**
- Modify: `src/app/suppliers/SupplierInventoryOverview.tsx:197-214` (the two scope-toggle buttons)

- [ ] **Step 1: Rename "All products" → "All products" (unchanged) and "★ Primary only" → "★ One per product"**

Replace the two `<button>` blocks at lines 197-214:

```tsx
<button
  type="button"
  role="tab"
  aria-selected={scope === "all"}
  onClick={() => setScope("all")}
  style={SCOPE_PILL(scope === "all")}
>
  All products
</button>
<button
  type="button"
  role="tab"
  aria-selected={scope === "one-per-product"}
  onClick={() => setScope("one-per-product")}
  style={SCOPE_PILL(scope === "one-per-product", "#16a34a")}
  title="Hide cross-supplier duplicates: show the primary row for each cluster, or the most recent if no primary is set."
>
  ★ One per product
</button>
```

Also update the `anyFilterActive` check at line 131 (the comparison value):

```ts
const anyFilterActive =
  !!search ||
  projectFilter !== "all" ||
  supplierFilter !== "all" ||
  partNameFilter !== "all" ||
  scope !== "all";
```

(unchanged in shape — the literal `"all"` is still the default and reset target.)

- [ ] **Step 2: Manual smoke**

Run `npm run dev`. Open `/suppliers` → Inventory & Manufacturing → Supplier Catalogue tab. Verify:
- Toggle shows "All products" and "★ One per product".
- Click "★ One per product" → catalogue dedupes (no clusters with multiple cards visible).
- Click "All products" → every row returns.
- A cluster that has NO row marked primary still surfaces ONE card in "One per product" mode (the most recent).

- [ ] **Step 3: Commit**

```bash
git add src/app/suppliers/SupplierInventoryOverview.tsx
git commit -m "fix(suppliers): rename scope toggle to 'One per product' for clarity"
```

---

## Phase 2 — Add Product: server pipeline (Part B of spec)

### Task 3: Add `SupplierProductExtraction` type + `extractSupplierProductFromUrl` helper

**Files:**
- Modify: `src/lib/ai/extract.ts` (append after existing exports)
- Create: `scripts/test-supplier-extract.ts`

- [ ] **Step 1: Append the new extraction function and types to `src/lib/ai/extract.ts`**

Append at the end of the file:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Supplier product extraction
// Used by the "Add product" flow on the Supplier Catalogue. Reads a product
// URL through Perplexity, then asks Claude to structure the result against a
// supplier-product schema (matches src/db/schema.ts > supplierProducts) plus
// the supplier-resolution fields (name/website/email) so the caller can match
// against existing suppliers or create a new one.
// ─────────────────────────────────────────────────────────────────────────────

import { SUPPLIER_CATEGORIES } from "@/app/suppliers/supplier-inventory-constants";

export type SupplierProductConfigurationExtraction = {
  name: string;
  productCode: string | null;
  description: string | null;
};

export type SupplierProductExtraction = {
  name: string;
  productCode: string | null;
  category: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  imageUrls: string[];
  supplierName: string | null;
  supplierWebsite: string | null;
  supplierEmail: string | null;
  configurations: SupplierProductConfigurationExtraction[];
};

export async function extractSupplierProductFromUrl(input: {
  url: string;
  supplierHint?: string;
  categoryHint?: string;
}): Promise<SupplierProductExtraction> {
  const { url, supplierHint, categoryHint } = input;
  const trimmed = url.trim();
  if (!trimmed) throw new Error("URL is required");

  // 1) Ask Perplexity to read the page and return the structured material.
  //    Same pattern as extractSingleProduct above.
  const pplxPrompt = [
    `Read this product page: ${trimmed}`,
    `Return the visible product information as plain text. Include:`,
    `- product name`,
    `- product code / SKU / model number`,
    `- short description`,
    `- category (light fixture, hardware, electronics, etc.)`,
    `- the manufacturer / brand name (NOT the retailer if different)`,
    `- the brand's website domain`,
    `- the brand's contact email if shown`,
    `- direct URLs to product images (large, not thumbnails)`,
    `- any variant table / configuration list (sizes, voltages, finishes, etc.) with each variant's code`,
    supplierHint ? `Hint: the supplier is likely "${supplierHint}".` : "",
    categoryHint ? `Hint: the category is likely "${categoryHint}".` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const pplx = await perplexityChat({ prompt: pplxPrompt });
  const pageNotes = pplx.text || "";

  // 2) Ask Claude to structure the notes into our schema. Use JSON mode so
  //    the response is parseable without ad-hoc regex.
  const categoryList = SUPPLIER_CATEGORIES.join(", ");
  const claudePrompt = [
    `You are extracting a supplier-product card for an ERP catalogue.`,
    `Source notes (already collected from the product page):`,
    `"""`,
    pageNotes,
    `"""`,
    ``,
    `Respond ONLY with a JSON object matching this TypeScript type:`,
    `{`,
    `  "name": string,                       // product name`,
    `  "productCode": string | null,          // SKU / model number`,
    `  "category": string | null,             // pick ONE of: ${categoryList}, or null`,
    `  "description": string | null,          // 1-3 short sentences`,
    `  "thumbnailUrl": string | null,         // best single image URL`,
    `  "imageUrls": string[],                 // up to 6 additional image URLs`,
    `  "supplierName": string | null,         // manufacturer / brand`,
    `  "supplierWebsite": string | null,      // brand website (full URL)`,
    `  "supplierEmail": string | null,        // brand contact email`,
    `  "configurations": Array<{`,
    `    "name": string,`,
    `    "productCode": string | null,`,
    `    "description": string | null`,
    `  }>                                      // empty array if none`,
    `}`,
    ``,
    `Rules:`,
    `- For category, only use one of the listed values. Set null if uncertain.`,
    `- supplierName is the MANUFACTURER, not the reseller/retailer.`,
    `- Configurations: only include variants that have their OWN product code.`,
    `  Plain text variants without codes belong in description, not configurations.`,
  ].join("\n");

  const claude = claudeClient();
  const resp = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: claudePrompt }],
  });

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  const jsonText = block.text.trim().replace(/^```json\n?|\n?```$/g, "");
  let parsed: SupplierProductExtraction;
  try {
    parsed = JSON.parse(jsonText) as SupplierProductExtraction;
  } catch (e) {
    throw new Error(`Claude returned non-JSON: ${(e as Error).message}\n${jsonText.slice(0, 200)}`);
  }

  // Defensive defaults — Claude sometimes omits optional arrays.
  if (!Array.isArray(parsed.imageUrls)) parsed.imageUrls = [];
  if (!Array.isArray(parsed.configurations)) parsed.configurations = [];
  // Snap category to allowed list.
  if (parsed.category && !SUPPLIER_CATEGORIES.includes(parsed.category as never)) {
    parsed.category = null;
  }

  if (!parsed.name || !parsed.name.trim()) {
    throw new Error("Extraction missing required field: name");
  }
  return parsed;
}
```

- [ ] **Step 2: Verify the imports at the top of `extract.ts`**

Confirm these are already imported at the top of the file (add any missing):

```ts
import { perplexityChat } from "./perplexity";
import { claudeClient, CLAUDE_MODEL } from "./claude";
```

If `perplexityChat` and `claudeClient` aren't already imported, add them.

- [ ] **Step 3: Write the smoke script**

Create `scripts/test-supplier-extract.ts`:

```ts
// Smoke for extractSupplierProductFromUrl.
// Run: npx tsx --env-file=.env scripts/test-supplier-extract.ts <product-url>
import { extractSupplierProductFromUrl } from "../src/lib/ai/extract";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: tsx scripts/test-supplier-extract.ts <product-url>");
    process.exit(1);
  }
  console.log(`Extracting: ${url}`);
  const t0 = Date.now();
  const result = await extractSupplierProductFromUrl({ url });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
```

- [ ] **Step 4: Run the smoke against a real product URL**

```bash
npx tsx --env-file=.env scripts/test-supplier-extract.ts "https://www.signify.com/global/our-brands/philips"
```

(Or any product URL you have handy. Expect ~10–40s. Verify the printed JSON has plausible `name`, `supplierName`, `imageUrls`, and a `configurations` array.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/extract.ts scripts/test-supplier-extract.ts
git commit -m "feat(suppliers): extractSupplierProductFromUrl via Perplexity + Claude"
```

### Task 4: Add the supplier-resolution + product-match server helpers

**Files:**
- Modify: `src/app/suppliers/supplier-inventory-actions.ts` (append a new section at the end)

- [ ] **Step 1: Add three helpers to the end of `supplier-inventory-actions.ts`**

Append:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Add-product orchestration helpers
// Used by /api/suppliers/add-product/* routes. Kept here for proximity to the
// other supplier-inventory queries; the route logic itself lives in
// src/app/suppliers/add-product-actions.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type SupplierResolutionCandidate = {
  id: number;
  name: string;
  website: string | null;
  // "domain" = the supplierWebsite matched this supplier's website domain.
  // "name"   = case-insensitive name match.
  // "hint"   = the user-supplied hint matched fuzzily.
  matchKind: "domain" | "name" | "hint";
};

function normaliseDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export async function findSuppliersForResolution(input: {
  supplierName: string | null;
  supplierWebsite: string | null;
  supplierHint: string | null;
}): Promise<SupplierResolutionCandidate[]> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  await ensureSupplierInventorySchema();

  const tenantClientId = profile.clientId ?? null;
  const rows = tenantClientId == null
    ? await db
        .select({ id: suppliers.id, name: suppliers.name, website: suppliers.website })
        .from(suppliers)
    : await db
        .select({ id: suppliers.id, name: suppliers.name, website: suppliers.website })
        .from(suppliers)
        .where(eq(suppliers.clientId, tenantClientId));

  const targetDomain = normaliseDomain(input.supplierWebsite);
  const targetName = input.supplierName?.trim().toLowerCase() ?? "";
  const hint = input.supplierHint?.trim().toLowerCase() ?? "";

  const out: SupplierResolutionCandidate[] = [];
  const seen = new Set<number>();
  function push(c: SupplierResolutionCandidate) {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
  }

  if (targetDomain) {
    for (const r of rows) {
      if (normaliseDomain(r.website) === targetDomain) {
        push({ id: r.id, name: r.name, website: r.website, matchKind: "domain" });
      }
    }
  }
  if (targetName) {
    for (const r of rows) {
      if (r.name.trim().toLowerCase() === targetName) {
        push({ id: r.id, name: r.name, website: r.website, matchKind: "name" });
      }
    }
  }
  if (hint) {
    for (const r of rows) {
      if (r.name.trim().toLowerCase().includes(hint)) {
        push({ id: r.id, name: r.name, website: r.website, matchKind: "hint" });
      }
    }
  }
  return out;
}

export type ExistingProductMatchCandidate = {
  partId: number;
  globalProductId: string;
  productCode: string;
  name: string;
  supplierName: string;
};

export async function findExistingProductsByCode(input: {
  productCode: string;
}): Promise<ExistingProductMatchCandidate[]> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  await ensureSupplierInventorySchema();

  const code = input.productCode.trim();
  if (!code) return [];

  const tenantClientId = profile.clientId ?? null;
  const rows = await db
    .select({
      partId: supplierProducts.id,
      globalProductId: supplierProducts.globalProductId,
      productCode: supplierProducts.productCode,
      name: supplierProducts.name,
      supplierName: suppliers.name,
      supplierClientId: suppliers.clientId,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(
      and(
        sql`LOWER(TRIM(${supplierProducts.productCode})) = LOWER(${code})`,
        sql`${supplierProducts.parentProductId} IS NULL`,
        eq(supplierProducts.archived, false),
      ),
    );

  return rows
    .filter(
      (r) =>
        tenantClientId == null || r.supplierClientId === tenantClientId,
    )
    .filter((r): r is typeof r & { globalProductId: string; productCode: string } =>
      !!r.globalProductId && !!r.productCode,
    )
    .map((r) => ({
      partId: r.partId,
      globalProductId: r.globalProductId,
      productCode: r.productCode,
      name: r.name,
      supplierName: r.supplierName,
    }));
}

export async function createSupplierForExtraction(input: {
  name: string;
  website: string | null;
  email: string | null;
}): Promise<{ id: number }> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  if (!canEdit(profile)) {
    throw new Error("Unauthorized: missing edit permission");
  }
  const name = input.name.trim();
  if (!name) throw new Error("Supplier name is required");

  const tenantClientId = profile.clientId ?? null;
  const [row] = await db
    .insert(suppliers)
    .values({
      name,
      website: input.website?.trim() || null,
      email: input.email?.trim() || null,
      clientId: tenantClientId,
      status: "Active",
    })
    .returning({ id: suppliers.id });

  revalidatePath("/suppliers");
  return { id: row.id };
}
```

- [ ] **Step 2: Verify `canEdit` is imported at the top of `supplier-inventory-actions.ts`**

Check the imports near the top of the file. If `canEdit` isn't imported from `@/lib/permissions`, add it to the import line that already pulls `getOrCreateProfile`, `canViewSuppliers`, etc.

- [ ] **Step 3: Type-check the file**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no new errors from this file. (Pre-existing errors in unrelated files are fine; we're isolating the change.)

- [ ] **Step 4: Commit**

```bash
git add src/app/suppliers/supplier-inventory-actions.ts
git commit -m "feat(suppliers): supplier resolution + existing-product code-match helpers"
```

### Task 5: Add the streaming orchestration helper

**Files:**
- Create: `src/app/suppliers/add-product-actions.ts`

- [ ] **Step 1: Create the orchestration file**

Create `src/app/suppliers/add-product-actions.ts`:

```ts
"use server";

// Orchestration for the Supplier Catalogue "Add product" flow.
// Two stages, each backed by its own Route Handler:
//   1) extract — fetch URL → Perplexity → Claude → match candidates.
//   2) commit  — write supplier_products row(s), download images, attach files.
//
// The two stages live in separate endpoints so the user can confirm the
// supplier resolution and the existing-product link choice between them. The
// extract endpoint streams progress via SSE; the commit endpoint is a single
// JSON request.

import { put } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { supplierProducts, supplierProductAttachments } from "@/db/schema";
import {
  extractSupplierProductFromUrl,
  type SupplierProductExtraction,
} from "@/lib/ai/extract";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canEdit,
} from "@/lib/permissions";
import {
  findSuppliersForResolution,
  findExistingProductsByCode,
  type SupplierResolutionCandidate,
  type ExistingProductMatchCandidate,
} from "./supplier-inventory-actions";

export type AddSupplierProductProgress = {
  step:
    | "starting"
    | "perplexity"
    | "claude"
    | "matching-supplier"
    | "matching-product"
    | "done";
  percent: number;
  detail: string | null;
};

export type AddSupplierProductExtractResult = {
  extraction: SupplierProductExtraction;
  supplierCandidates: SupplierResolutionCandidate[];
  productMatchCandidates: ExistingProductMatchCandidate[];
};

export async function extractSupplierProductStreaming(input: {
  url: string;
  supplierHint?: string;
  categoryHint?: string;
  onProgress: (e: AddSupplierProductProgress) => void;
}): Promise<AddSupplierProductExtractResult> {
  const { url, supplierHint, categoryHint, onProgress } = input;

  onProgress({ step: "perplexity", percent: 10, detail: "Reading the product page" });
  // extractSupplierProductFromUrl does perplexity + claude internally; we
  // narrate the steps by bracketing the call. If we later want fine-grained
  // progress we can split extractSupplierProductFromUrl into two calls.
  const extraction = await extractSupplierProductFromUrl({
    url,
    supplierHint,
    categoryHint,
  });
  onProgress({ step: "claude", percent: 55, detail: "Structured product card" });

  onProgress({ step: "matching-supplier", percent: 70, detail: "Looking up suppliers" });
  const supplierCandidates = await findSuppliersForResolution({
    supplierName: extraction.supplierName,
    supplierWebsite: extraction.supplierWebsite,
    supplierHint: supplierHint ?? null,
  });

  onProgress({ step: "matching-product", percent: 85, detail: "Looking up existing products" });
  const productMatchCandidates = extraction.productCode
    ? await findExistingProductsByCode({ productCode: extraction.productCode })
    : [];

  onProgress({ step: "done", percent: 100, detail: null });
  return { extraction, supplierCandidates, productMatchCandidates };
}

export type CommitSupplierProductInput = {
  // Supplier selection: either an existing supplier id, or the create payload.
  supplier:
    | { kind: "existing"; supplierId: number }
    | {
        kind: "new";
        name: string;
        website: string | null;
        email: string | null;
      };
  // Linking: when set, the new product joins this cluster instead of getting
  // its own fresh globalProductId.
  linkToGlobalProductId: string | null;
  // The product card itself. May come from extraction (auto-fill) or from the
  // manual form. The commit endpoint doesn't care which.
  product: {
    name: string;
    productCode: string | null;
    category: string | null;
    description: string | null;
    thumbnailUrl: string | null; // remote URL — downloaded into blob here
    imageUrls: string[]; // additional images — attached as "other_file" rows
  };
  configurations: Array<{
    name: string;
    productCode: string | null;
    description: string | null;
  }>;
};

export type CommitSupplierProductResult = {
  partId: number;
  supplierId: number;
  configurationIds: number[];
};

// Downloads a single remote image into Vercel Blob and returns the public URL +
// pathname. Returns null on failure (logged) — the row still saves, just
// without a thumbnail.
async function downloadToBlob(
  remoteUrl: string,
  prefix: string,
): Promise<{ url: string; pathname: string } | null> {
  try {
    const res = await fetch(remoteUrl, { redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const cleanName =
      (remoteUrl.split("/").pop() || "image").split("?")[0] || "image";
    const safe = cleanName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) ||
      "image";
    const blob = await put(`${prefix}/${Date.now()}-${safe}`, buf, {
      access: "public",
      addRandomSuffix: true,
    });
    return { url: blob.url, pathname: blob.pathname };
  } catch (e) {
    console.warn("[add-product] image download failed:", remoteUrl, e);
    return null;
  }
}

export async function commitSupplierProduct(
  input: CommitSupplierProductInput,
): Promise<CommitSupplierProductResult> {
  const profile = await getOrCreateProfile();
  if (!profile) throw new Error("Unauthorized: not signed in");
  if (!canViewSuppliers(profile)) {
    throw new Error("Unauthorized: missing supplier-view permission");
  }
  if (!canEdit(profile)) {
    throw new Error("Unauthorized: missing edit permission");
  }

  // 1) Resolve supplier id (existing or freshly created).
  let supplierId: number;
  if (input.supplier.kind === "existing") {
    supplierId = input.supplier.supplierId;
  } else {
    const { createSupplierForExtraction } = await import(
      "./supplier-inventory-actions"
    );
    const created = await createSupplierForExtraction({
      name: input.supplier.name,
      website: input.supplier.website,
      email: input.supplier.email,
    });
    supplierId = created.id;
  }

  // 2) Download thumbnail if extraction gave us a remote URL.
  let thumbnailUrl: string | null = null;
  let thumbnailPathname: string | null = null;
  if (input.product.thumbnailUrl) {
    const downloaded = await downloadToBlob(
      input.product.thumbnailUrl,
      `supplier-products/${supplierId}`,
    );
    if (downloaded) {
      thumbnailUrl = downloaded.url;
      thumbnailPathname = downloaded.pathname;
    }
  }

  // 3) Pick / generate the globalProductId.
  //    - If linkToGlobalProductId is set, join that cluster.
  //    - Else mint a fresh one.
  const globalProductId =
    input.linkToGlobalProductId ?? `gp-${crypto.randomUUID()}`;

  // 4) Insert the top-level part row.
  const [partRow] = await db
    .insert(supplierProducts)
    .values({
      supplierId,
      parentProductId: null,
      globalProductId,
      isPrimarySupplier: false,
      name: input.product.name.trim(),
      productCode: input.product.productCode?.trim() || null,
      category: input.product.category?.trim() || null,
      description: input.product.description?.trim() || null,
      thumbnailUrl,
      thumbnailPathname,
      createdByRole: profile.role === "admin" ? "lightbase" : "lightbase",
      createdByClerkId: profile.clerkUserId,
    })
    .returning({ id: supplierProducts.id });

  // 5) Insert configuration rows.
  const configurationIds: number[] = [];
  for (const cfg of input.configurations) {
    const cfgName = cfg.name.trim();
    if (!cfgName) continue;
    const [cfgRow] = await db
      .insert(supplierProducts)
      .values({
        supplierId,
        parentProductId: partRow.id,
        globalProductId: `gp-${crypto.randomUUID()}`,
        isPrimarySupplier: false,
        name: cfgName,
        productCode: cfg.productCode?.trim() || null,
        description: cfg.description?.trim() || null,
        category: null,
        createdByRole: "lightbase",
        createdByClerkId: profile.clerkUserId,
      })
      .returning({ id: supplierProducts.id });
    configurationIds.push(cfgRow.id);
  }

  // 6) Download remaining images, attach as "other_file" rows under the part.
  for (const remote of input.product.imageUrls.slice(0, 6)) {
    const downloaded = await downloadToBlob(
      remote,
      `supplier-products/${supplierId}/${partRow.id}`,
    );
    if (!downloaded) continue;
    await db.insert(supplierProductAttachments).values({
      productId: partRow.id,
      category: "other_file",
      label: "Image",
      url: downloaded.url,
      pathname: downloaded.pathname,
      fileName: downloaded.pathname.split("/").pop() ?? "image",
      uploadedByRole: "lightbase",
      uploadedByClerkId: profile.clerkUserId,
    });
  }

  revalidatePath("/suppliers");
  revalidatePath("/portal");

  return {
    partId: partRow.id,
    supplierId,
    configurationIds,
  };
}
```

- [ ] **Step 2: Verify the schema columns referenced exist**

Open `src/db/schema.ts` and confirm `supplierProductAttachments` has columns `category`, `label`, `url`, `pathname`, `fileName`, `uploadedByRole`, `uploadedByClerkId`. If any of those names don't match, adjust the insert call accordingly (the file is the source of truth).

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no new errors from `add-product-actions.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/app/suppliers/add-product-actions.ts
git commit -m "feat(suppliers): add-product orchestration (extract streaming + commit)"
```

### Task 6: Create the extract SSE Route Handler

**Files:**
- Create: `src/app/api/suppliers/add-product/extract/route.ts`

- [ ] **Step 1: Write the SSE endpoint**

Create `src/app/api/suppliers/add-product/extract/route.ts`:

```ts
// Streaming extract endpoint for the Supplier Catalogue add-product flow.
// Mirrors /api/competitors/add-product:
//   POST body: { url, supplierHint?, categoryHint? }
//   On the wire: SSE lines, one JSON object per "data:" line:
//     { type: "progress", step, detail, percent }
//     { type: "done",     result }   // AddSupplierProductExtractResult
//     { type: "error",    message }

import {
  extractSupplierProductStreaming,
  type AddSupplierProductProgress,
} from "@/app/suppliers/add-product-actions";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canEdit,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sseLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

type Body = {
  url?: string;
  supplierHint?: string;
  categoryHint?: string;
};

export async function POST(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = body.url?.trim();
  if (!url) {
    return new Response(
      JSON.stringify({ error: "url is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        } catch {
          closed = true;
        }
      }, 5_000);

      try {
        safeEnqueue(
          sseLine({
            type: "progress",
            step: "starting",
            percent: 0,
            detail: null,
          }),
        );
        const onProgress = (e: AddSupplierProductProgress) => {
          safeEnqueue(sseLine({ type: "progress", ...e }));
        };
        const result = await extractSupplierProductStreaming({
          url,
          supplierHint: body.supplierHint,
          categoryHint: body.categoryHint,
          onProgress,
        });
        safeEnqueue(sseLine({ type: "done", result }));
      } catch (e) {
        safeEnqueue(
          sseLine({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/app/api/suppliers/add-product/extract/route.ts
git commit -m "feat(suppliers): SSE extract endpoint for add-product flow"
```

### Task 7: Create the commit Route Handler

**Files:**
- Create: `src/app/api/suppliers/add-product/commit/route.ts`

- [ ] **Step 1: Write the commit endpoint**

Create `src/app/api/suppliers/add-product/commit/route.ts`:

```ts
import {
  commitSupplierProduct,
  type CommitSupplierProductInput,
} from "@/app/suppliers/add-product-actions";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canEdit,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  let body: CommitSupplierProductInput;
  try {
    body = (await request.json()) as CommitSupplierProductInput;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!body?.product?.name?.trim()) {
    return new Response(
      JSON.stringify({ error: "product.name is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  try {
    const result = await commitSupplierProduct(body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/suppliers/add-product/commit/route.ts
git commit -m "feat(suppliers): commit endpoint for add-product flow"
```

---

## Phase 3 — Add Product: client UI

### Task 8: Build the dialog shell + Tab 2 (Manual)

**Files:**
- Create: `src/app/suppliers/AddProductDialog.tsx`

- [ ] **Step 1: Scaffold the dialog with the Manual tab fully wired**

Create `src/app/suppliers/AddProductDialog.tsx`:

```tsx
"use client";

// "+ Add product" dialog mounted on the Supplier Catalogue overview.
// Two tabs:
//   1) From URL — Perplexity + Claude auto-fill (uses /api/suppliers/add-product/extract).
//   2) Manual   — pure form entry.
// On submit (either tab), POSTs to /api/suppliers/add-product/commit.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ProgressPanel,
  consumeSseStream,
  formatDuration,
  type StreamProgressEvent,
} from "@/app/competitors/_progress";
import { SUPPLIER_CATEGORIES } from "./supplier-inventory-constants";
import type {
  AddSupplierProductExtractResult,
  CommitSupplierProductInput,
  CommitSupplierProductResult,
} from "./add-product-actions";

type SupplierOption = { id: number; name: string };

export default function AddProductDialog({
  open,
  onClose,
  onCreated,
  suppliers,
  preselectedSupplierId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  suppliers: SupplierOption[];
  preselectedSupplierId: number | null;
}) {
  const [tab, setTab] = useState<"url" | "manual">("url");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  return (
    <ModalShell title="+ Add product to the supplier catalogue" onClose={onClose}>
      <TabBar tab={tab} setTab={setTab} />
      {err && <ErrorBanner message={err} />}
      {tab === "url" ? (
        <UrlTab
          suppliers={suppliers}
          preselectedSupplierId={preselectedSupplierId}
          onError={setErr}
          onBusy={setBusy}
          busy={busy}
          onCreated={() => {
            onCreated();
            onClose();
          }}
        />
      ) : (
        <ManualTab
          suppliers={suppliers}
          preselectedSupplierId={preselectedSupplierId}
          onError={setErr}
          onBusy={setBusy}
          busy={busy}
          onCreated={() => {
            onCreated();
            onClose();
          }}
        />
      )}
    </ModalShell>
  );
}

// ── Tab bar ────────────────────────────────────────────────────────────────
function TabBar({
  tab,
  setTab,
}: {
  tab: "url" | "manual";
  setTab: (t: "url" | "manual") => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 6,
        padding: 4,
        background: "var(--lb-bg)",
        border: "1px solid var(--lb-border)",
        borderRadius: 999,
        marginBottom: 12,
        alignSelf: "flex-start",
      }}
    >
      {(["url", "manual"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => setTab(t)}
          style={{
            padding: "6px 14px",
            fontSize: 12.5,
            fontWeight: 700,
            borderRadius: 999,
            border: "1px solid transparent",
            background: tab === t ? "var(--lb-bg-elev)" : "transparent",
            color: tab === t ? "var(--lb-text)" : "var(--lb-text-3)",
            cursor: "pointer",
          }}
        >
          {t === "url" ? "From URL (AI)" : "Manual"}
        </button>
      ))}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: 10,
        marginBottom: 12,
        borderRadius: 8,
        background: "rgba(220,38,38,0.10)",
        border: "1px solid rgba(220,38,38,0.40)",
        color: "#dc2626",
        fontSize: 12.5,
      }}
    >
      {message}
    </div>
  );
}

// ── Manual tab ─────────────────────────────────────────────────────────────
function ManualTab({
  suppliers,
  preselectedSupplierId,
  onError,
  onBusy,
  busy,
  onCreated,
}: {
  suppliers: SupplierOption[];
  preselectedSupplierId: number | null;
  onError: (msg: string | null) => void;
  onBusy: (b: boolean) => void;
  busy: boolean;
  onCreated: () => void;
}) {
  const [supplierId, setSupplierId] = useState<number | null>(
    preselectedSupplierId,
  );
  const [supplierQuery, setSupplierQuery] = useState("");
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [name, setName] = useState("");
  const [productCode, setProductCode] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");

  const filteredSuppliers = useMemo(() => {
    const q = supplierQuery.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((s) => s.name.toLowerCase().includes(q));
  }, [suppliers, supplierQuery]);

  async function submit() {
    onError(null);
    if (!supplierId) {
      onError("Pick a supplier (or create a new one) first.");
      return;
    }
    if (!name.trim()) {
      onError("Product name is required.");
      return;
    }
    onBusy(true);
    try {
      // Check for existing product code match — if there is one, prompt.
      let linkTo: string | null = null;
      const code = productCode.trim();
      if (code) {
        const matchRes = await fetch(`/api/suppliers/find-by-code?code=${encodeURIComponent(code)}`)
          .then((r) => (r.ok ? r.json() : { candidates: [] }))
          .catch(() => ({ candidates: [] }));
        const cands: Array<{ globalProductId: string; supplierName: string }> =
          matchRes.candidates ?? [];
        if (cands.length > 0) {
          const list = cands
            .map((c) => c.supplierName)
            .filter((s, i, arr) => arr.indexOf(s) === i)
            .join(", ");
          const ok = window.confirm(
            `Product code "${code}" already exists under ${list}. Link this new entry as an alternative supplier on that cluster?\n\nOK = Link as alternative\nCancel = Keep as a separate product`,
          );
          if (ok) linkTo = cands[0].globalProductId;
        }
      }
      const body: CommitSupplierProductInput = {
        supplier: { kind: "existing", supplierId },
        linkToGlobalProductId: linkTo,
        product: {
          name,
          productCode: productCode || null,
          category: category || null,
          description: description || null,
          thumbnailUrl: null,
          imageUrls: [],
        },
        configurations: [],
      };
      const res = await fetch("/api/suppliers/add-product/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Commit failed (${res.status})`);
      }
      onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label="Supplier *">
        <input
          type="search"
          value={supplierQuery}
          onChange={(e) => setSupplierQuery(e.target.value)}
          placeholder={
            supplierId
              ? suppliers.find((s) => s.id === supplierId)?.name ?? "Search…"
              : "Search suppliers…"
          }
          style={INPUT_STYLE}
        />
        <div
          style={{
            marginTop: 6,
            maxHeight: 140,
            overflowY: "auto",
            border: "1px solid var(--lb-border)",
            borderRadius: 8,
          }}
        >
          {filteredSuppliers.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSupplierId(s.id);
                setSupplierQuery("");
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                background: s.id === supplierId ? "var(--lb-bg-elev)" : "transparent",
                color: "var(--lb-text)",
                border: "none",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {s.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowNewSupplier(true)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 10px",
              background: "transparent",
              color: "var(--lb-accent)",
              border: "none",
              borderTop: "1px solid var(--lb-border)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            + Create new supplier
          </button>
        </div>
      </Field>

      <Field label="Name *">
        <input value={name} onChange={(e) => setName(e.target.value)} style={INPUT_STYLE} />
      </Field>
      <Field label="Product code">
        <input
          value={productCode}
          onChange={(e) => setProductCode(e.target.value)}
          style={INPUT_STYLE}
        />
      </Field>
      <Field label="Category">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={INPUT_STYLE}
        >
          <option value="">— select a category —</option>
          {SUPPLIER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...INPUT_STYLE, minHeight: 70, resize: "vertical" }}
        />
      </Field>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Creating…" : "Create product"}
        </button>
      </div>

      {showNewSupplier && (
        <NewSupplierSubDialog
          onClose={() => setShowNewSupplier(false)}
          onCreated={(s) => {
            setShowNewSupplier(false);
            setSupplierId(s.id);
          }}
        />
      )}
    </div>
  );
}

// ── URL tab (extraction + commit) ──────────────────────────────────────────
function UrlTab({
  suppliers,
  preselectedSupplierId,
  onError,
  onBusy,
  busy,
  onCreated,
}: {
  suppliers: SupplierOption[];
  preselectedSupplierId: number | null;
  onError: (msg: string | null) => void;
  onBusy: (b: boolean) => void;
  busy: boolean;
  onCreated: () => void;
}) {
  const [url, setUrl] = useState("");
  const [supplierHint, setSupplierHint] = useState(
    preselectedSupplierId
      ? suppliers.find((s) => s.id === preselectedSupplierId)?.name ?? ""
      : "",
  );
  const [categoryHint, setCategoryHint] = useState("");
  const [progress, setProgress] = useState<StreamProgressEvent | null>(null);
  const [extracted, setExtracted] =
    useState<AddSupplierProductExtractResult | null>(null);
  const startedAtRef = useRef<number>(0);
  const [nowMs, setNowMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // 1s ticker for elapsed time once extraction starts.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  async function startExtract() {
    onError(null);
    setExtracted(null);
    const trimmed = url.trim();
    if (!trimmed) {
      onError("URL is required.");
      return;
    }
    onBusy(true);
    startedAtRef.current = Date.now();
    setNowMs(Date.now());
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch("/api/suppliers/add-product/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: trimmed,
          supplierHint: supplierHint || undefined,
          categoryHint: categoryHint || undefined,
        }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Extract failed (${res.status})`);
      }
      await consumeSseStream<AddSupplierProductExtractResult>(res.body, {
        onProgress: (e) => setProgress(e),
        onDone: (result) => setExtracted(result),
        onError: (msg) => onError(msg),
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        onError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      onBusy(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  if (extracted) {
    return (
      <ConfirmExtraction
        extracted={extracted}
        suppliers={suppliers}
        onError={onError}
        onCancel={() => setExtracted(null)}
        onCreated={onCreated}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label="Product URL *">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.brand.com/products/..."
          style={INPUT_STYLE}
          autoFocus
        />
      </Field>
      <Field label="Supplier hint (optional)">
        <input
          value={supplierHint}
          onChange={(e) => setSupplierHint(e.target.value)}
          placeholder="e.g. Asahi"
          style={INPUT_STYLE}
        />
      </Field>
      <Field label="Category hint (optional)">
        <select
          value={categoryHint}
          onChange={(e) => setCategoryHint(e.target.value)}
          style={INPUT_STYLE}
        >
          <option value="">— no hint —</option>
          {SUPPLIER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      {progress && (
        <ProgressPanel
          progress={progress}
          elapsedSec={(nowMs - startedAtRef.current) / 1000}
          onCancel={busy ? cancel : undefined}
        />
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={startExtract}
          disabled={busy}
          style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? `Extracting… (${formatDuration((nowMs - startedAtRef.current) / 1000)})` : "Extract from URL"}
        </button>
      </div>
    </div>
  );
}

// ── Confirm-extraction step (between extract & commit) ─────────────────────
function ConfirmExtraction({
  extracted,
  suppliers,
  onError,
  onCancel,
  onCreated,
}: {
  extracted: AddSupplierProductExtractResult;
  suppliers: SupplierOption[];
  onError: (msg: string | null) => void;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { extraction, supplierCandidates, productMatchCandidates } = extracted;
  const [chosenSupplierId, setChosenSupplierId] = useState<number | null>(
    supplierCandidates[0]?.id ?? null,
  );
  const [linkToCluster, setLinkToCluster] = useState<boolean>(
    productMatchCandidates.length > 0,
  );
  const [name, setName] = useState(extraction.name);
  const [productCode, setProductCode] = useState(extraction.productCode ?? "");
  const [description, setDescription] = useState(extraction.description ?? "");
  const [category, setCategory] = useState(extraction.category ?? "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    onError(null);
    if (chosenSupplierId == null && !extraction.supplierName) {
      onError("Pick a supplier (or extraction must include a supplier name).");
      return;
    }
    setBusy(true);
    try {
      const linkTo =
        linkToCluster && productMatchCandidates.length > 0
          ? productMatchCandidates[0].globalProductId
          : null;
      const supplier =
        chosenSupplierId != null
          ? ({ kind: "existing", supplierId: chosenSupplierId } as const)
          : ({
              kind: "new",
              name: extraction.supplierName!,
              website: extraction.supplierWebsite,
              email: extraction.supplierEmail,
            } as const);
      const body: CommitSupplierProductInput = {
        supplier,
        linkToGlobalProductId: linkTo,
        product: {
          name,
          productCode: productCode || null,
          category: category || null,
          description: description || null,
          thumbnailUrl: extraction.thumbnailUrl,
          imageUrls: extraction.imageUrls,
        },
        configurations: extraction.configurations,
      };
      const res = await fetch("/api/suppliers/add-product/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Commit failed (${res.status})`);
      }
      const result: CommitSupplierProductResult = await res.json();
      console.log("[add-product] created", result);
      onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionHeader title="Extracted product card" subtitle="Tweak any field before saving." />
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} style={INPUT_STYLE} />
      </Field>
      <Field label="Product code">
        <input
          value={productCode}
          onChange={(e) => setProductCode(e.target.value)}
          style={INPUT_STYLE}
        />
      </Field>
      <Field label="Category">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={INPUT_STYLE}
        >
          <option value="">— select a category —</option>
          {SUPPLIER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...INPUT_STYLE, minHeight: 70, resize: "vertical" }}
        />
      </Field>

      <SectionHeader
        title="Supplier"
        subtitle={
          supplierCandidates.length > 0
            ? "Pick a matched supplier, or use the extracted one to create a new supplier row."
            : "No matching supplier found — saving will create a new supplier row from extracted data."
        }
      />
      <select
        value={chosenSupplierId == null ? "__new" : String(chosenSupplierId)}
        onChange={(e) =>
          setChosenSupplierId(
            e.target.value === "__new" ? null : Number(e.target.value),
          )
        }
        style={INPUT_STYLE}
      >
        {supplierCandidates.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.name} ({c.matchKind} match)
          </option>
        ))}
        {extraction.supplierName && (
          <option value="__new">
            + Create new supplier: {extraction.supplierName}
          </option>
        )}
        {suppliers
          .filter((s) => !supplierCandidates.some((c) => c.id === s.id))
          .map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name} (manual pick)
            </option>
          ))}
      </select>

      {productMatchCandidates.length > 0 && (
        <>
          <SectionHeader
            title="Existing product match"
            subtitle={`Product code matches ${productMatchCandidates.length} existing row(s) under: ${productMatchCandidates
              .map((c) => c.supplierName)
              .filter((s, i, arr) => arr.indexOf(s) === i)
              .join(", ")}.`}
          />
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontSize: 13,
              color: "var(--lb-text-2)",
            }}
          >
            <input
              type="checkbox"
              checked={linkToCluster}
              onChange={(e) => setLinkToCluster(e.target.checked)}
            />
            Link as alternative supplier on the existing cluster
          </label>
        </>
      )}

      {extraction.configurations.length > 0 && (
        <SectionHeader
          title="Configurations"
          subtitle={`${extraction.configurations.length} variant(s) will be created as nested rows.`}
        />
      )}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <button type="button" onClick={onCancel} style={MINI_BTN}>
          ← Start over
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Saving…" : "Save product"}
        </button>
      </div>
    </div>
  );
}

// ── New-supplier sub-dialog (used by Manual tab) ───────────────────────────
function NewSupplierSubDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: SupplierOption) => void;
}) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/suppliers/create-for-extraction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          website: website || null,
          email: email || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Create failed (${res.status})`);
      }
      const data: { id: number } = await res.json();
      onCreated({ id: data.id, name: name.trim() });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="New supplier" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {err && <ErrorBanner message={err} />}
        <Field label="Name *">
          <input value={name} onChange={(e) => setName(e.target.value)} style={INPUT_STYLE} autoFocus />
        </Field>
        <Field label="Website">
          <input value={website} onChange={(e) => setWebsite(e.target.value)} style={INPUT_STYLE} />
        </Field>
        <Field label="Email">
          <input value={email} onChange={(e) => setEmail(e.target.value)} style={INPUT_STYLE} />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={MINI_BTN}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            style={{ ...PRIMARY_BTN, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Creating…" : "Create supplier"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── shared bits ────────────────────────────────────────────────────────────
function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 60,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--lb-bg-elev)",
          border: "1px solid var(--lb-border)",
          borderRadius: 14,
          width: "min(640px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
          color: "var(--lb-text)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "-0.01em" }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--lb-text-3)",
              fontSize: 20,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
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
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          color: "var(--lb-text-3)",
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div style={{ fontSize: 12, color: "var(--lb-text-3)", marginTop: 2 }}>{subtitle}</div>
      )}
    </div>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 8,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg)",
  color: "var(--lb-text)",
};

const PRIMARY_BTN: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 999,
  border: "1px solid var(--lb-accent)",
  background: "var(--lb-accent)",
  color: "var(--lb-accent-fg)",
  cursor: "pointer",
};

const MINI_BTN: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12.5,
  fontWeight: 600,
  borderRadius: 999,
  border: "1px solid var(--lb-border)",
  background: "var(--lb-bg)",
  color: "var(--lb-text-2)",
  cursor: "pointer",
};
```

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/app/suppliers/AddProductDialog.tsx
git commit -m "feat(suppliers): AddProductDialog with URL + manual tabs"
```

### Task 9: Add two tiny API endpoints the dialog needs

The dialog references `/api/suppliers/find-by-code` and `/api/suppliers/create-for-extraction`. Wire them.

**Files:**
- Create: `src/app/api/suppliers/find-by-code/route.ts`
- Create: `src/app/api/suppliers/create-for-extraction/route.ts`

- [ ] **Step 1: Write the code-match endpoint**

Create `src/app/api/suppliers/find-by-code/route.ts`:

```ts
import { findExistingProductsByCode } from "@/app/suppliers/supplier-inventory-actions";
import { getOrCreateProfile, canViewSuppliers } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!code) {
    return new Response(JSON.stringify({ candidates: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const candidates = await findExistingProductsByCode({ productCode: code });
    return new Response(JSON.stringify({ candidates }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
```

- [ ] **Step 2: Write the create-supplier endpoint**

Create `src/app/api/suppliers/create-for-extraction/route.ts`:

```ts
import { createSupplierForExtraction } from "@/app/suppliers/supplier-inventory-actions";
import { getOrCreateProfile, canViewSuppliers, canEdit } from "@/lib/permissions";

export const dynamic = "force-dynamic";

type Body = {
  name?: string;
  website?: string | null;
  email?: string | null;
};

export async function POST(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!body.name?.trim()) {
    return new Response(JSON.stringify({ error: "name is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const result = await createSupplierForExtraction({
      name: body.name,
      website: body.website ?? null,
      email: body.email ?? null,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/suppliers/find-by-code/route.ts src/app/api/suppliers/create-for-extraction/route.ts
git commit -m "feat(suppliers): code-match + create-supplier API endpoints"
```

### Task 10: Mount the dialog on the catalogue overview

**Files:**
- Modify: `src/app/suppliers/SupplierInventoryOverview.tsx`

- [ ] **Step 1: Import the dialog at the top of the file**

Near the existing imports add:

```ts
import AddProductDialog from "./AddProductDialog";
```

- [ ] **Step 2: Add an `addOpen` state and an "+ Add product" button**

Inside the component, after the existing `useState` calls, add:

```ts
const [addOpen, setAddOpen] = useState(false);
```

In the header pill row (the same `<div>` that wraps the scope toggle pills and the count badge — around line 173), insert at the start (before the scope-toggle role="tablist"):

```tsx
{canEdit && (
  <button
    type="button"
    onClick={() => setAddOpen(true)}
    style={{
      padding: "6px 14px",
      fontSize: 12.5,
      fontWeight: 700,
      borderRadius: 999,
      border: "1px solid var(--lb-accent)",
      background: "var(--lb-accent)",
      color: "var(--lb-accent-fg)",
      cursor: "pointer",
    }}
  >
    + Add product
  </button>
)}
```

- [ ] **Step 3: Mount the dialog at the bottom of the JSX**

After the existing `{openPart && <ProductDrawerLoader …/>}` block, add:

```tsx
<AddProductDialog
  open={addOpen}
  onClose={() => setAddOpen(false)}
  onCreated={() => reload()}
  suppliers={suppliers}
  preselectedSupplierId={
    supplierFilter !== "all" ? Number(supplierFilter) : null
  }
/>
```

- [ ] **Step 4: Type-check + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/app/suppliers/SupplierInventoryOverview.tsx
git commit -m "feat(suppliers): mount AddProductDialog in catalogue overview"
```

---

## Phase 4 — Verification

### Task 11: End-to-end smoke

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Manual: scope toggle**

Navigate to `/suppliers` → Inventory & Manufacturing → **Supplier Catalogue**.
Toggle between "All products" and "★ One per product". Verify:
- "All products" shows the full list.
- "One per product" deduplicates. A cluster with no primary still surfaces ONE card.

- [ ] **Step 3: Manual: Add Product → URL flow**

Click **+ Add product** → **From URL** tab.
Paste a real product URL (any brand catalogue page). Click **Extract from URL**.
Verify:
- Progress panel shows step labels and percent.
- After ~10–40s, the confirmation step renders with the extracted name, code, description, supplier candidates, configurations.
- Save → toast/no error, dialog closes, catalogue reloads, new card appears under the resolved supplier.

- [ ] **Step 4: Manual: Add Product → URL flow with existing code match**

Pick a URL whose `productCode` already exists in your catalogue (or run twice with the same URL).
Verify: the "Existing product match" section appears in the confirmation step with a checkbox prefilled. On save, the new row joins the existing cluster (open the original product's drawer → the new supplier shows as an alternative).

- [ ] **Step 5: Manual: Add Product → Manual tab**

Switch to **Manual** tab. Search for an existing supplier, pick one, fill name + code + category. Click **Create product**.
Verify: new card appears in the catalogue under that supplier.

- [ ] **Step 6: Manual: Add Product → Manual tab → Create new supplier**

Manual tab → click **+ Create new supplier** at the bottom of the supplier picker. Fill name + website + email. Save the sub-dialog.
Verify: supplier is selected automatically. Fill product fields, save. New supplier appears on /suppliers list AND the new product is under that supplier in the catalogue.

- [ ] **Step 7: Report any failures and triage**

If any of the above steps fails, capture the exact error from the browser console + dev server logs and triage. Common spots:
- `extractSupplierProductFromUrl` returning non-JSON → Claude prompt needs tightening (edit `src/lib/ai/extract.ts`, re-run `scripts/test-supplier-extract.ts`).
- Schema column name mismatch in `supplierProductAttachments` insert → adjust `add-product-actions.ts` to match `src/db/schema.ts`.
- Auth 401 → confirm the logged-in user has `canEdit` permission.

---

## Self-review notes

- **Spec coverage:** Part A (scope fix) → Phase 1. Part B (URL flow, manual flow, supplier resolution, existing-product match, configurations) → Phases 2 & 3. SSE protocol implemented as two endpoints (extract streaming + commit) rather than single-stream pause-and-resume — cleaner, same UX. All 5 spec assumptions honored.
- **Type consistency:** `SupplierProductExtraction` (extract.ts) ↔ `extraction` field on `AddSupplierProductExtractResult` (add-product-actions.ts) ↔ payload used by `ConfirmExtraction` (AddProductDialog.tsx). Field names consistent throughout. `CommitSupplierProductInput.supplier` discriminated union matches the dialog's branching.
- **No placeholders.** Every code block is complete.
- **Frequent commits.** Each task ends with a commit. 11 commits total across the plan.

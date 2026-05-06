# Frontend Redesign — Industrial / Operational Aesthetic via Google Stitch

**Date:** 2026-05-05
**Status:** Phase 0 + Phase 1 complete (Stitch system + tokens + shell). Phases 2-4 in follow-up plans.
**Approach:** Stitch-led page-by-page rebuild (Approach 2)

## Goal

Redesign the entire Lightbase Operations frontend with a modern, sleek, functional industrial/operational aesthetic. Use Google Stitch to generate canonical screen designs, then rebuild each React page to match. All existing functionality (server actions, drag-drop, file uploads, charts, drawers, modals, AI flows, Clerk auth, permissions) is preserved.

## Stack constraints

- **Next.js 16.2.4** with App Router. This is a non-standard Next.js — APIs and conventions may differ from training data; consult `node_modules/next/dist/docs/` before novel API usage.
- **React 19.2.4**.
- **Tailwind CSS v4** with `@theme inline` token mapping in `globals.css`.
- **shadcn 4.6.0** primitives are installed; we'll align them with the new tokens, not replace them.
- **Clerk** for auth (`@clerk/nextjs ^7.2.9`) — its components are theme-able but not freely restylable.
- **chart.js + react-chartjs-2** stay; we restyle palettes, not the renderer.
- **Drizzle + Neon** untouched. No schema changes in this work.

## Visual direction (decisions)

| Decision | Choice |
|---|---|
| Aesthetic family | Industrial / Operational (Palantir, Retool, Tekion, Foundry) |
| Color personality | Minimal neutral; status colors only |
| Default theme | Light, with dark toggle available |
| Navigation | Left sidebar (collapsible) + thin top bar |
| Density | Compact — information-dense, grid-friendly |
| Geometry | Sharp; small radii (4-8px); hairline 1px borders |
| Typography | Geist sans (display + body), Geist Mono for IDs/SKUs/codes |
| Motion | Minimal, functional only — no decorative animation |

### Color tokens

| Token | Light | Dark |
|---|---|---|
| `--lb-bg` | `#fafafa` | `#0a0a0a` |
| `--lb-bg-elev` | `#ffffff` | `#141414` |
| `--lb-bg-sunken` | `#f4f4f5` | `#050505` |
| `--lb-text` | `#0a0a0a` | `#fafafa` |
| `--lb-text-2` | `#52525b` | `#a1a1aa` |
| `--lb-text-3` | `#71717a` | `#71717a` |
| `--lb-border` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.08)` |
| `--lb-border-strong` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.16)` |
| `--lb-accent` | `#18181b` | `#fafafa` |
| `--lb-accent-fg` | `#fafafa` | `#0a0a0a` |
| `--lb-success` | `#10b981` | `#34d399` |
| `--lb-warning` | `#f59e0b` | `#fbbf24` |
| `--lb-danger` | `#ef4444` | `#f87171` |
| `--lb-info` | `#3b82f6` | `#60a5fa` |

The accent is intentionally near-monochrome (graphite on white, white on graphite). Color appears only when it carries meaning (status, charts).

### Typography scale

- `--lb-text-12` 12px / 16 — captions, table meta, tags
- `--lb-text-13` 13px / 18 — table cells, secondary UI text
- `--lb-text-14` 14px / 20 — body, controls
- `--lb-text-15` 15px / 22 — emphasized body
- `--lb-text-18` 18px / 26 — section titles
- `--lb-text-22` 22px / 30 — page titles
- `--lb-text-32` 32px / 38 — hero / landing only

Headings use `font-weight: 600`, tracking `-0.011em`. Mono is reserved for SKUs, barcodes, IDs, file paths, code.

### Geometry

- `--lb-radius-xs` 4px — inputs, pills inside tables
- `--lb-radius-sm` 6px — buttons, small surfaces
- `--lb-radius` 8px — cards, drawers
- `--lb-radius-lg` 12px — modals
- Borders: 1px hairline only. No double borders.
- Shadows: at most one elevation step (`0 1px 2px rgba(0,0,0,.06)`) on cards. Modals get `0 8px 24px rgba(0,0,0,.12)`.

## Layout

### App shell

- **Left sidebar** — 240px expanded, 56px collapsed (icons only). Persistent on desktop, drawer on mobile.
  - Top: Lightbase mark + product name, click toggles collapse
  - Middle: primary nav groups (Inventory & Manufacturing, Competitors & Market Research, Process, Engineering, Admin) with sub-items expanded inline
  - Bottom: user pill (avatar, email, role badge, sign-out)
- **Top bar** — 48px tall, holds breadcrumbs (left), global search slot (center, reserved for future), theme toggle + user avatar (right). Sticky.
- **Main** — full remaining width, scrolls independently.

### Page templates

1. **List/grid template** — page header (title, subtitle, primary action), filter row, data view (table/cards), optional right drawer for detail
2. **Detail template** — sticky header with breadcrumb + actions, tabbed body, footer with audit info
3. **Form/edit template** — single-column form, max 720px, stacked sections with hairline separators
4. **Iframe-content template** (handbook, engineering) — same shell, full-bleed iframe inside main
5. **Empty state template** — centered icon + headline + sub + primary CTA
6. **Auth template** (sign-in, sign-up, awaiting-access) — centered card on sunken background

## Pages to redesign

Every existing page in `src/app/` plus the global shell:

1. `app/layout.tsx` — root shell (sidebar + top bar)
2. `app/page.tsx` — home / awaiting-access
3. `app/sign-in/[[...sign-in]]/page.tsx`
4. `app/sign-up/[[...sign-up]]/page.tsx`
5. `app/suppliers/page.tsx` — Inventory & Manufacturing
   - `InventoryAndManufacturing.tsx` — sub-tab shell
   - `SuppliersView.tsx`
   - `SupplierCharts.tsx`
   - `BarcodeGenerator.tsx`
   - `StubTab.tsx` (placeholder for Inventory, POs, Manufacturing, BOMs, Quality, Maintenance)
6. `app/competitors/page.tsx`
   - `CompetitorsView.tsx` — top container
   - `SummaryView.tsx`
   - `BenchmarkView.tsx`
   - `IdeationBoard.tsx`
   - `IdeationDetailDrawer.tsx`
   - `ProductDetailDrawer.tsx`
   - `AddProductForm.tsx`
   - `FilePreviewModal.tsx`
   - `SketchOverlay.tsx`
7. `app/handbook/page.tsx` — iframe wrapper
8. `app/engineering/page.tsx` — iframe wrapper
9. `app/admin/page.tsx`
   - `AdminPanel.tsx`

## Component primitives

Built once in `src/components/ui/` (or aligned shadcn equivalents). Every page composes from these:

| Primitive | Notes |
|---|---|
| `Button` | variants: primary, secondary, ghost, destructive, icon |
| `IconButton` | square, 32/28/24px sizes |
| `Input`, `Textarea`, `Select`, `Combobox`, `Switch`, `Checkbox`, `Radio`, `DatePicker` | hairline borders, focus ring uses `--lb-accent` at 18% opacity |
| `Table` | sortable headers, sticky first col on horizontal scroll, density toggle, row hover, row selection |
| `StatusPill` | success, warning, danger, info, neutral; size sm/md |
| `Tag` | low-emphasis label |
| `Card`, `Surface` | hairline + 1px shadow |
| `Drawer` | right-side, 420px / 560px / fullscreen variants |
| `Modal` | centered, max 640px |
| `Tabs`, `SubTabs` | underline style for primary, pill style for secondary |
| `Breadcrumbs` | uses Next.js routing |
| `Sidebar`, `SidebarGroup`, `SidebarItem` | with collapse state |
| `EmptyState` | icon + headline + sub + CTA |
| `Toast` | bottom-right stack |
| `Tooltip` | dark-on-light + light-on-dark |
| `Avatar`, `UserPill` | initials + optional image |
| `KeyValue` | label / value pair, used in detail panels |
| `Kbd` | keyboard shortcut hint |

Drag-drop (used in Ideation board) keeps its current React implementation; only the visual treatment of cards and drop zones changes.

## Stitch workflow

1. Create Stitch project: `Lightbase Operations`
2. Create Stitch design system encoding the tokens, type scale, geometry, status colors, and density rules above
3. Apply that design system to every screen generation
4. Generate canonical screens (one per page template + the unique surfaces below):
   - App shell (sidebar expanded + collapsed states)
   - Home / awaiting-access
   - Sign-in (Clerk-themed)
   - Suppliers list
   - Supplier detail drawer
   - Inventory & Manufacturing landing (sub-tab shell)
   - Barcode generator
   - Stub tab (used for Inventory, POs, MOs, BOMs, Quality, Maintenance placeholders)
   - Competitors summary
   - Brand detail / product cards
   - Product detail drawer
   - Benchmark grid
   - Ideation board (kanban-like)
   - Ideation detail drawer
   - File preview modal
   - Handbook (iframe shell)
   - Admin panel (user list + filter chips + actions)
   - Empty state
   - Toast / banner
5. Use Stitch screens as the visual source of truth. React implementation matches them, but is not constrained by Stitch's exact code output.

## Implementation phases

### Phase 0 — Stitch design system
- Create project + design system in Stitch
- Generate sidebar/top-bar app shell
- Output: agreed visual reference for everything that follows

### Phase 1 — Tokens + shell
- Rewrite `globals.css` token blocks (`:root` and `.dark`) to match the new system
- Bridge Tailwind v4 / shadcn vars to the same token set so existing shadcn components inherit automatically
- Implement App shell: `src/components/AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `Breadcrumbs.tsx`
- Implement theme toggle (light / dark / system)
- Update `app/layout.tsx` to use the new shell
- Remove the old top-tab nav (`src/components/TopNav.tsx`)
- Output: every page renders inside the new shell with new tokens, even before its internals are restyled

### Phase 2 — Primitive library
- Build the primitives listed above in `src/components/ui/`
- Each primitive ships with all variants used across the app, validated against the Stitch screens
- Output: a coherent component palette ready to be used

### Phase 3 — Page rebuilds (one PR-sized chunk per cluster)
1. Suppliers cluster (`suppliers/page.tsx`, `InventoryAndManufacturing`, `SuppliersView`, `SupplierCharts`, `BarcodeGenerator`, `StubTab`)
2. Competitors cluster (`CompetitorsView`, `SummaryView`, `BenchmarkView`, `IdeationBoard`, `IdeationDetailDrawer`, `ProductDetailDrawer`, `AddProductForm`, `FilePreviewModal`, `SketchOverlay`)
3. Auth + landing (`page.tsx`, `sign-in`, `sign-up`)
4. Handbook + Engineering (iframe shells)
5. Admin (`AdminPanel`)

For each page: match the corresponding Stitch screen, replace styling and structural markup, leave server actions / event handlers / data flow / Clerk hooks / permission checks untouched.

### Phase 4 — Polish
- Dark mode pass on every page
- Mobile responsive pass (sidebar drawer, table-to-card collapse where useful)
- Chart palette pass (industrial-neutral palette across `chart.js`)
- Clerk appearance prop tuning to match auth screens

## Functionality preservation (non-negotiable)

- All server actions in `src/app/**/*-actions.ts` and `actions.ts` files keep their signatures and behavior
- Drag-drop in Ideation board keeps working
- File uploads via Vercel Blob keep working
- AI flows (Anthropic + OpenAI) keep working
- Clerk auth flows keep working
- Permissions logic in `src/lib/permissions.ts` is read-only to this work
- Drizzle schema in `src/db/schema.ts` is read-only to this work
- Charts continue to render with `react-chartjs-2`
- Routing structure unchanged; only `app/layout.tsx` and components are touched

## Out of scope

- Database schema changes
- New features or new tabs
- Changes to permission logic
- Mobile-specific features (general responsive yes; mobile-only flows no)
- Re-platforming away from Tailwind / shadcn / Clerk / Drizzle
- Restructuring the routing tree

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Stitch outputs don't match each other in style | Use a single shared Stitch design system; generate all screens with `apply_design_system` |
| shadcn primitives drift from new tokens | Update shadcn vars in `globals.css` to point at the same token values; don't fork shadcn |
| Clerk sign-in/up pages look off-theme | Use Clerk's `appearance` prop with token-driven values; treat them as "shell + Clerk" rather than fully custom |
| Dark mode regressions on chart colors | Define explicit chart palette in tokens, pass through chart.js options |
| Drag-drop visual breakage in Ideation | Restyle, don't restructure the DnD primitives; keep drop-target classes intact |
| Iframe pages (handbook/engineering) look detached | New shell stays consistent around them; iframe content is owned separately and is out of scope |

## Success criteria

- Every page renders inside the new sidebar shell
- All tokens come from a single source; no hard-coded hex outside the token file
- Light and dark modes are both polished, not one as an afterthought
- Every Stitch screen has a matching React implementation
- No regressions in: supplier CRUD, competitor CRUD, AI flows, drag-drop, file uploads, auth, permissions
- TypeScript and ESLint clean
- Lighthouse a11y score on Suppliers and Competitors pages ≥ 95

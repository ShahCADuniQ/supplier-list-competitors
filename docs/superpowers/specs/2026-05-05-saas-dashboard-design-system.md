# Lightbase SaaS Dashboard Design System

**Status:** Active. Supersedes the earlier industrial/light spec dated 2026-05-05.
**Reference:** Dribbble shot 27264980 — *Modern Analytics Dashboard UI Design - Dark Theme SaaS Panel*.
**User-approved:** 2026-05-05 after seeing commit `892774c` land on master.

## Aesthetic in one line

Modern SaaS analytics dashboard. Dark by default. Vivid cobalt + orange accents. Pill controls. Narrow icon-only sidebar with active glow. Bold UPPERCASE page titles. Soft, rounded card geometry. Generous spacing. Information confident — not packed.

## Source of truth

`src/app/globals.css` is the single source of truth for tokens, helper classes, and chart colors. Every page consumes those. Subsequent design changes update tokens here first, never per-page hex codes.

---

## Color tokens

### Surfaces (dark, default)

| Token | Value | Use |
|---|---|---|
| `--lb-bg` | `#0c0d11` | App background, sidebar background |
| `--lb-bg-elev` | `#1a1c22` | Cards, top bar, inputs, sub-nav pills |
| `--lb-bg-sunken` | `#16181d` | Search input fill, hover states |

### Surfaces (light, secondary)

| Token | Value |
|---|---|
| `--lb-bg` | `#f6f7fb` |
| `--lb-bg-elev` | `#ffffff` |
| `--lb-bg-sunken` | `#eef0f6` |

### Text

| Token | Dark | Light |
|---|---|---|
| `--lb-text` | `#ffffff` | `#0a0b10` |
| `--lb-text-2` | `#a0a3ad` | `#5a6072` |
| `--lb-text-3` | `#6e7280` | `#8a90a0` |

### Borders

| Token | Dark | Light |
|---|---|---|
| `--lb-border` | `rgba(255,255,255,0.06)` | `rgba(10,11,16,0.08)` |
| `--lb-border-strong` | `rgba(255,255,255,0.12)` | `rgba(10,11,16,0.16)` |

### Accent (primary CTA)

| Token | Value |
|---|---|
| `--lb-accent` | `#2563ff` (cobalt) |
| `--lb-accent-fg` | `#ffffff` |
| `--lb-accent-hover` | `#3a76ff` |
| `--lb-accent-active` | `#1d4eff` |
| `--lb-glow-accent` | `0 0 0 3px rgba(37,99,255,0.45)` (focus + active rail glow) |

### Vivid hero card colors

Used as full-bleed backgrounds on KPI panels — solid color, white text, large numbers. Apply via `.lb-card-vivid-orange|blue|violet|teal`.

| Token | Value |
|---|---|
| `--lb-vivid-orange` | `#ff4d2e` |
| `--lb-vivid-blue` | `#2563ff` |
| `--lb-vivid-violet` | `#8b5cf6` |
| `--lb-vivid-teal` | `#14b8a6` |

### Status

| Token | Dark | Light |
|---|---|---|
| `--lb-success` | `#4ade80` | `#34d399` |
| `--lb-warning` | `#fbbf24` | `#fbbf24` |
| `--lb-danger` | `#ff4d2e` | `#ff4d2e` |
| `--lb-info` | `#3a76ff` | `#2563ff` |

### Charts

| Token | Value |
|---|---|
| `--lb-chart-bar-top` | `#4ade80` (lime) |
| `--lb-chart-bar-bottom` | `#1740d4` (deep cobalt) |
| `--lb-chart-line-1` | `#4ade80` |
| `--lb-chart-line-2` | `#2563ff` |
| `--lb-chart-line-3` | `#ff4d2e` |
| `--lb-chart-line-4` | `#fbbf24` |
| `--lb-chart-line-5` | `#a78bfa` |

Bars use a vertical gradient from `--lb-chart-bar-top` to `--lb-chart-bar-bottom`. Donuts use the same palette ringed concentrically.

---

## Geometry

| Token | Value | Use |
|---|---|---|
| `--lb-radius-xs` | `8px` | Small inline elements |
| `--lb-radius-sm` | `12px` | Inputs, small cards |
| `--lb-radius` | `18px` | Default card |
| `--lb-radius-lg` | `22px` | Large cards |
| `--lb-radius-xl` | `28px` | Hero KPI cards |
| `--lb-radius-pill` | `9999px` | Buttons, search input, status chips, sub-nav tabs, dropdowns |

**No double borders.** All borders are `1px` hairline using `--lb-border`. Heavy shadows reserved for modals and hero cards only.

---

## Typography

- Family: **Geist** (sans) for everything; **Geist Mono** for IDs/SKUs/codes
- Headings: weight `700`, tracking `-0.022em`
- Body: weight `400-500`, tracking `-0.01em`
- Section titles: bold uppercase, tracking `0.04em`, via `.lb-section-title`

### Scale

| Token | Size |
|---|---|
| `--lb-text-12` | 12px (captions, table meta) |
| `--lb-text-13` | 13px (table cells, secondary) |
| `--lb-text-14` | 14px (body, controls) |
| `--lb-text-15` | 15px (emphasis) |
| `--lb-text-18` | 18px (section title) |
| `--lb-text-22` | 22px (page title in card) |
| `--lb-text-32` | 32px (hero numbers) |

The TopBar page title is custom: 26px, weight 800, all-caps.

---

## Layout

### App shell

- **Sidebar** — fixed `--lb-sidebar-w: 80px` width. Always icon-only. No collapse toggle. Position: flex-row alongside main content.
  - Brand mark at top: 44×44 cobalt accent square, radius 14, white "L" character
  - Nav items: 44×44 rounded-square slots (radius 14). Inactive uses `--lb-bg-elev` + `--lb-border`. Active uses `--lb-accent` background + `--lb-glow-accent` ring.
  - Footer: settings cog + 40×40 user avatar circle
- **TopBar** — `--lb-topbar-h: 72px` tall, sticky, transparent background.
  - Left: bold UPPERCASE page title at 26px / weight 800
  - Center: pill search input (40px tall, full pill radius, search icon prefix)
  - Right: theme toggle + Clerk `<UserButton />`
- **SubNav** — appears below the TopBar when on a route group. Pill tabs with active = `--lb-accent` fill / inactive = `--lb-bg-elev` + border. 36px tall, full pill radius, 16px horizontal padding. Hidden on routes that don't belong to a group.
- **Main** — fills remaining viewport height. Independently scrollable. Padding decided per-page (typically 24-32px).

### Page templates

1. **Data dashboard** — hero KPI cards row (2-4 vivid panels), then a wide chart, then a list/table. Used for Suppliers, Competitors Summary.
2. **List + drawer** — toolbar (search + filters + primary CTA), table or grid, optional right-side detail drawer. Used for Suppliers, Competitor brand grid.
3. **Kanban** — column rail with drag-drop cards. Used for Ideation board.
4. **Form** — single-column max-width 720px, stacked sections separated by hairline.
5. **Iframe** — iframe wrapper with rounded corners + border, fills remaining height. Used for Process and Engineering handbooks (external HTML content).
6. **Empty state** — centered icon + headline + sub + primary CTA.
7. **Auth** — centered card on sunken background, no shell. Used for sign-in / sign-up.

---

## Components

Built into `globals.css` as helper classes for now; a follow-up plan extracts them into React primitives in `src/components/ui/`.

| Class | Purpose |
|---|---|
| `.lb-card` | Default card — surface bg, hairline border, radius `18`, soft shadow |
| `.lb-card-vivid-{orange,blue,violet,teal}` | Hero KPI card — full-bleed solid color, white text, radius `22`, no border |
| `.lb-glass` | Top-bar / strip surface — elevated bg + bottom hairline |
| `.lb-btn` | Pill button — 36px tall, hairline border, ghost-on-elevated by default |
| `.lb-btn-primary` | Cobalt fill, white text |
| `.lb-btn-ghost` | Borderless transparent |
| `.lb-input` | Pill input — 40px tall, sunken bg, `--lb-border`, focus ring uses `--lb-glow-accent` |
| `.lb-label` | 12px / weight 500 / muted-text label |
| `.lb-section-title` | Bold uppercase 15px + tracking `0.04em` |
| `.lb-mono` | Mono stack with tabular nums |
| `.lb-bar-gradient` | Lime-to-cobalt vertical gradient (chart bar fill) |

### Sub-nav pattern

When a route belongs to a group of sibling routes (e.g., `/competitors` / `/handbook` / `/engineering` are all "Design & Engineering" siblings), render the `<SubNav>` strip below the TopBar. Each tab is a 36px pill: active = `--lb-accent` fill + white text; inactive = `--lb-bg-elev` + `--lb-border`. Tabs are role-gated.

In-page sub-tabs (e.g., the eight Inventory & Manufacturing modules inside `/suppliers`) follow the **same pill pattern**, even though they don't change the URL — visual consistency with route-based sub-tabs.

---

## Motion

- 120-160ms ease for hover / state transitions
- 100ms transform for press feedback (`scale(0.98)`)
- No decorative animation, no parallax, no autoplay

---

## Functionality preservation

This design system is the visual layer. The architecture beneath is untouched:

- All Next.js routes
- All server actions in `src/app/**/*-actions.ts`
- All Drizzle queries in `src/db/`
- All Clerk auth flows
- All permissions in `src/lib/permissions.ts`
- All file uploads via Vercel Blob
- All AI flows (Anthropic + OpenAI)
- All drag-and-drop interactions
- All `react-chartjs-2` charts (palette restyled, renderer untouched)

A redesign that breaks any of the above is a regression, not a redesign.

---

## Do / don't

### Do
- Pull every color from `var(--lb-*)`. No raw hex outside this file.
- Use `.lb-card-vivid-*` for hero panels that carry meaning (KPIs, primary actions). Sparingly.
- Use `.lb-section-title` for section labels in pages.
- Use the SubNav strip (or in-page pill tabs styled identically) whenever a page has siblings.
- Match button height (36px) and input height (40px) consistently.

### Don't
- Don't introduce new accent colors. The vivid orange/blue/violet/teal set is closed.
- Don't bring back marketing-style heroes (eyebrow + giant H1 + subtitle) inside pages — the TopBar carries the page title now.
- Don't use sharp 4-8px radii anywhere visible. Defaults are 18+.
- Don't blur backgrounds (`backdrop-filter`) — flat surfaces only.
- Don't add new chart palettes — pull from `--lb-chart-*`.

---

## Active reference commits

| Commit | Description |
|---|---|
| `892774c` | Foundation pivot: dark default, vivid accents, narrow icon rail, pill TopBar |
| `6de00f1` | SubNav for Design & Engineering sibling routes |

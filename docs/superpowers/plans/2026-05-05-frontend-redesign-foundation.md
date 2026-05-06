# Frontend Redesign — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new industrial / operational design foundation — Stitch design system, token + helper-class rewrite in `globals.css`, and a left-sidebar app shell — so subsequent per-cluster plans can rebuild pages on a stable base.

**Architecture:** All visual decisions live in `src/app/globals.css` as CSS custom properties. The `.lb-*` helper classes (`.lb-btn`, `.lb-input`, `.lb-card`, etc.) are rewritten so existing pages immediately inherit the industrial look without per-page edits. shadcn vars in the same file point at the same tokens so shadcn primitives stay consistent. A new `AppShell` composes a collapsible `Sidebar` + slim `TopBar` + `Breadcrumbs` and replaces the inline header in `app/layout.tsx`. The old `TopNav.tsx` is deleted.

**Tech Stack:** Next.js 16.2.4 App Router · React 19.2.4 · Tailwind CSS v4 · shadcn 4.6.0 · Geist / Geist Mono · Clerk · Google Stitch (design generation only).

**Spec:** [docs/superpowers/specs/2026-05-05-frontend-redesign-industrial-design.md](../specs/2026-05-05-frontend-redesign-industrial-design.md)

**Out of scope for this plan** (each gets its own follow-up plan):
- Primitive component library in `src/components/ui/` (Plan 2)
- Suppliers cluster page rebuild (Plan 3)
- Competitors cluster page rebuild (Plan 4)
- Auth + landing + handbook + engineering rebuild (Plan 5)
- Admin rebuild + chart palette + Clerk theming + responsive polish (Plan 6)

---

## Files

### Create

- `src/components/AppShell.tsx` — composes `Sidebar` + `TopBar` + main scroll area; owns sidebar collapsed state via React context so children (TopBar's collapse toggle) can read/write it.
- `src/components/Sidebar.tsx` — left sidebar (240px expanded / 56px collapsed); renders nav groups for `Inventory & Manufacturing`, `Competitors & Market Research`, `Process`, `Engineering`, `Admin`; receives the same role-gating props the old `TopNav` did; bottom-anchored user pill with email + role badge.
- `src/components/SidebarItem.tsx` — single nav row; uses `usePathname()` for active state; supports `icon` + `label` + `href`; renders icon-only when collapsed.
- `src/components/TopBar.tsx` — 48px tall; left: sidebar collapse toggle + `Breadcrumbs`; right: `ThemeToggle` + Clerk `UserButton`; sticky.
- `src/components/Breadcrumbs.tsx` — derives crumbs from `usePathname()` against a static route → label map; last crumb is non-link.
- `src/components/ThemeToggle.tsx` — light / dark / system; persists to `localStorage` key `lb-theme`; toggles `dark` class on `<html>`.
- `src/lib/theme.ts` — exports `applyStoredTheme()` which reads `localStorage` and applies the class; called from a tiny inline `<script>` injected in `<head>` to prevent FOUC.

### Modify

- `src/app/globals.css` — replace `:root` and `.dark` token blocks with the new industrial palette + add type scale + add layout vars; rewrite `.lb-btn`, `.lb-input`, `.lb-card`, `.lb-glass`, `.lb-label` helpers to match (sharper radii, no pill buttons, hairline borders, neutral accent).
- `src/app/layout.tsx` — strip inline `<header>` JSX; wrap `{children}` in `<AppShell>`; pass profile + permissions; inject the no-FOUC theme `<script>`.

### Delete

- `src/components/TopNav.tsx` — replaced by `Sidebar.tsx`.

---

## Conventions used in this plan

- **Test loop** — this codebase has no unit-test framework. Each visible change is verified by: TypeScript (`npx tsc --noEmit`) → ESLint (`npm run lint`) → dev server visual check (`npm run dev`, browse the affected route). Where there's pure logic (e.g., `applyStoredTheme`), we add a tiny inline `node:test` runner in the same file under an `if (import.meta.vitest)`-style guard — but only where logic is non-trivial. None of the foundation work is logic-heavy enough to warrant test infra setup; that's deferred until a primitive needs it.
- **Commits** — one commit per task. Commit message format: `redesign: <task summary>`. Always include the spec path in the body of the first commit so traceability is captured.
- **Imports** — `@/` alias is configured (Next.js convention). Use `@/components/...` and `@/lib/...`.
- **Client vs server components** — `AppShell`, `Sidebar`, `SidebarItem`, `TopBar`, `Breadcrumbs`, `ThemeToggle` are all `"use client"`. `app/layout.tsx` stays a server component and passes serializable props down.
- **Stitch as reference, not source** — Stitch screens are visual ground truth, not source code. The React implementation matches the look but uses our codebase's idioms.

---

## Tasks

### Task 1: Set up Stitch project + design system

**Files:**
- (no codebase files; Stitch state is external, captured for reference in Task 2's commit)

- [ ] **Step 1: Create the Stitch project**

Call `mcp__stitch__create_project` with name `Lightbase Operations` and a one-paragraph description capturing the spec's intent. Save the returned `projectId`.

- [ ] **Step 2: Create the Stitch design system**

Call `mcp__stitch__create_design_system` with the following payload (the Stitch tool will accept it as natural-language guidance; map to whatever schema the tool exposes):

```text
Name: Lightbase Industrial
Personality: Industrial / operational. Minimal, neutral, information-dense.
References: Palantir Foundry, Retool, Tekion, Linear-but-quieter.

Color (light):
  bg #fafafa · surface #ffffff · sunken #f4f4f5
  text #0a0a0a · text-2 #52525b · text-3 #71717a
  border rgba(0,0,0,0.08) · border-strong rgba(0,0,0,0.16)
  accent #18181b on #fafafa (chrome, near-monochrome)
  status: success #10b981 · warning #f59e0b · danger #ef4444 · info #3b82f6

Color (dark):
  bg #0a0a0a · surface #141414 · sunken #050505
  text #fafafa · text-2 #a1a1aa · text-3 #71717a
  border rgba(255,255,255,0.08) · border-strong rgba(255,255,255,0.16)
  accent #fafafa on #0a0a0a
  status: success #34d399 · warning #fbbf24 · danger #f87171 · info #60a5fa

Typography:
  Display & body — Geist sans, 600 weight for headings, tracking -0.011em.
  Mono — Geist Mono, reserved for SKUs, barcodes, IDs, file paths.
  Scale (px / line): 12/16, 13/18, 14/20, 15/22, 18/26, 22/30, 32/38.

Geometry:
  Radii: 4 (xs, inputs/inline pills), 6 (sm, buttons), 8 (cards/drawers), 12 (modals).
  Borders: 1px hairline only. No double borders. No pill controls.
  Shadows: cards 0 1px 2px rgba(0,0,0,0.06). Modals 0 8px 24px rgba(0,0,0,0.12). Nothing else.

Density:
  Compact — table row min-height 36px, card padding 16, section spacing 24.

Motion: minimal, functional. Hover transitions 120ms. No decorative animation.
```

Save the returned `designSystemId`.

- [ ] **Step 3: Confirm via list**

Call `mcp__stitch__list_design_systems` and verify the new system appears.

- [ ] **Step 4: Record IDs**

No git commit yet (no files changed). Record the `projectId` and `designSystemId` in your scratchpad — Task 2 needs them.

---

### Task 2: Generate canonical reference screens in Stitch

**Files:**
- Create: `docs/superpowers/specs/stitch-references.md` — a short index of generated screens and their Stitch IDs so future plans (and humans) can re-open them.

- [ ] **Step 1: Generate each screen**

For each prompt below, call `mcp__stitch__generate_screen_from_text` with the design system from Task 1. Save each returned `screenId`.

| Screen | Prompt |
|---|---|
| App shell — sidebar expanded | "Operational web app shell. Left sidebar 240px with header logo `Lightbase`, primary nav groups: Inventory & Manufacturing (with sub-items Suppliers, Inventory, Purchase Orders, Manufacturing, BOMs, Quality, Maintenance, Barcodes), Competitors & Market Research (Summary, Benchmark, Ideation), Process, Engineering, Admin. Bottom: user pill (avatar + email + role tag). Top bar 48px tall with breadcrumbs `Inventory & Manufacturing / Suppliers`, theme toggle, user avatar. Main pane shows a placeholder data table." |
| App shell — sidebar collapsed | "Same operational shell, sidebar collapsed to 56px showing only icons. Tooltips on hover." |
| Suppliers list | "Suppliers list. Page header: title `Suppliers`, subtitle, primary button `Add supplier`. Filter row with search input, status select, region select. Table: name (with avatar), country, lead time (days), open POs, status pill, last contacted. Right side has a detail drawer open showing one supplier's projects, comments, attachments tabs." |
| Competitors summary | "Competitor brand grid. Cards show brand name, logo, tier tag (Mass / Mid / Spec / Premium), capability chips, last updated. Header has collection picker dropdown, search, `+ Add brand`." |
| Ideation board | "Kanban-style ideation board. Columns: Idea, Researching, Prototyping, Shipped. Cards show title, brand source pill, attachments count, comment count. Drag handle visible on hover." |
| Sign-in | "Centered Clerk-style sign-in card on sunken background. Lightbase logo top, email + password fields, primary `Sign in` button, secondary `Sign up` link." |
| Empty state | "Generic empty state: muted icon, headline `No suppliers yet`, sub `Add your first supplier to start tracking lead times.`, primary CTA `Add supplier`." |

- [ ] **Step 2: Write the references index**

Create `docs/superpowers/specs/stitch-references.md`:

```markdown
# Stitch Reference Index

Generated 2026-05-05 against design system **Lightbase Industrial**.

| Screen | Stitch ID |
|---|---|
| App shell — sidebar expanded | `<paste id>` |
| App shell — sidebar collapsed | `<paste id>` |
| Suppliers list | `<paste id>` |
| Competitors summary | `<paste id>` |
| Ideation board | `<paste id>` |
| Sign-in | `<paste id>` |
| Empty state | `<paste id>` |

Project: `<paste projectId>`
Design system: `<paste designSystemId>`

To re-open a screen: `mcp__stitch__get_screen` with the ID.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/stitch-references.md
git commit -m "redesign: index Stitch reference screens for foundation"
```

---

### Task 3: Rewrite token blocks + helper classes in `globals.css`

**Files:**
- Modify: `src/app/globals.css` (lines 51–214 — the `:root`, `.dark`, `:root{ --lb-* }`, `.dark, html.dark{ --lb-* }`, and `/* Reusable Apple-style primitives */` blocks)

- [ ] **Step 1: Read the current `globals.css`**

Confirm structure matches the snapshot from spec exploration: Tailwind import → shadcn imports → `@theme inline` → `:root` (shadcn vars) → `.dark` (shadcn vars) → `:root{ --lb-* }` → `.dark, html.dark{ --lb-* }` → `@layer base` → `.lb-glass` / `.lb-card` / `.lb-btn` / `.lb-btn-primary` / `.lb-btn-ghost` / `.lb-input` / `.lb-label`.

- [ ] **Step 2: Replace the shadcn `:root` block**

Replace lines 51–84 (the existing `:root { --background: oklch(...) ... }` block) with:

```css
:root {
  --background: #fafafa;
  --foreground: #0a0a0a;
  --card: #ffffff;
  --card-foreground: #0a0a0a;
  --popover: #ffffff;
  --popover-foreground: #0a0a0a;
  --primary: #18181b;
  --primary-foreground: #fafafa;
  --secondary: #f4f4f5;
  --secondary-foreground: #18181b;
  --muted: #f4f4f5;
  --muted-foreground: #52525b;
  --accent: #f4f4f5;
  --accent-foreground: #18181b;
  --destructive: #ef4444;
  --border: rgba(0, 0, 0, 0.08);
  --input: rgba(0, 0, 0, 0.16);
  --ring: rgba(24, 24, 27, 0.18);
  --chart-1: #3b82f6;
  --chart-2: #10b981;
  --chart-3: #f59e0b;
  --chart-4: #ef4444;
  --chart-5: #8b5cf6;
  --radius: 0.5rem;
  --sidebar: #ffffff;
  --sidebar-foreground: #0a0a0a;
  --sidebar-primary: #18181b;
  --sidebar-primary-foreground: #fafafa;
  --sidebar-accent: #f4f4f5;
  --sidebar-accent-foreground: #18181b;
  --sidebar-border: rgba(0, 0, 0, 0.08);
  --sidebar-ring: rgba(24, 24, 27, 0.18);
}
```

- [ ] **Step 3: Replace the shadcn `.dark` block**

Replace lines 86–118 (the `.dark { ... }` block) with:

```css
.dark {
  --background: #0a0a0a;
  --foreground: #fafafa;
  --card: #141414;
  --card-foreground: #fafafa;
  --popover: #141414;
  --popover-foreground: #fafafa;
  --primary: #fafafa;
  --primary-foreground: #0a0a0a;
  --secondary: #1f1f1f;
  --secondary-foreground: #fafafa;
  --muted: #1f1f1f;
  --muted-foreground: #a1a1aa;
  --accent: #1f1f1f;
  --accent-foreground: #fafafa;
  --destructive: #f87171;
  --border: rgba(255, 255, 255, 0.08);
  --input: rgba(255, 255, 255, 0.16);
  --ring: rgba(250, 250, 250, 0.18);
  --chart-1: #60a5fa;
  --chart-2: #34d399;
  --chart-3: #fbbf24;
  --chart-4: #f87171;
  --chart-5: #a78bfa;
  --sidebar: #141414;
  --sidebar-foreground: #fafafa;
  --sidebar-primary: #fafafa;
  --sidebar-primary-foreground: #0a0a0a;
  --sidebar-accent: #1f1f1f;
  --sidebar-accent-foreground: #fafafa;
  --sidebar-border: rgba(255, 255, 255, 0.08);
  --sidebar-ring: rgba(250, 250, 250, 0.18);
}
```

- [ ] **Step 4: Replace the `:root { --lb-* }` block**

Replace lines 123–145 (the `/* ─── Apple-inspired design system ──── */` `:root{...}` block) with:

```css
/* ─── Industrial / operational design tokens ─────────────────────────────
   Source of truth for all visuals. Helper classes below consume these,
   shadcn vars above mirror them. */
:root {
  /* Surfaces */
  --lb-bg: #fafafa;
  --lb-bg-elev: #ffffff;
  --lb-bg-sunken: #f4f4f5;

  /* Text */
  --lb-text: #0a0a0a;
  --lb-text-2: #52525b;
  --lb-text-3: #71717a;

  /* Borders */
  --lb-border: rgba(0, 0, 0, 0.08);
  --lb-border-strong: rgba(0, 0, 0, 0.16);

  /* Accent (near-monochrome by intent) */
  --lb-accent: #18181b;
  --lb-accent-fg: #fafafa;
  --lb-accent-hover: #27272a;
  --lb-accent-active: #09090b;

  /* Status */
  --lb-success: #10b981;
  --lb-warning: #f59e0b;
  --lb-danger: #ef4444;
  --lb-info: #3b82f6;

  /* Shadows */
  --lb-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
  --lb-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  --lb-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.12);

  /* Radii — sharper than before, no pills */
  --lb-radius-xs: 4px;
  --lb-radius-sm: 6px;
  --lb-radius: 8px;
  --lb-radius-lg: 12px;
  --lb-radius-pill: 6px; /* legacy alias — collapsed to sm so stale uses still feel industrial */

  /* Type */
  --lb-font-display: "Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
  --lb-font-text: "Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
  --lb-font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  /* Type scale */
  --lb-text-12: 12px;
  --lb-text-13: 13px;
  --lb-text-14: 14px;
  --lb-text-15: 15px;
  --lb-text-18: 18px;
  --lb-text-22: 22px;
  --lb-text-32: 32px;

  /* Layout */
  --lb-sidebar-w: 240px;
  --lb-sidebar-collapsed-w: 56px;
  --lb-topbar-h: 48px;
}
```

- [ ] **Step 5: Replace the `.dark` lb-* block**

Replace lines 146–160 (the `.dark, html.dark{ --lb-* }` block) with:

```css
.dark,
html.dark {
  --lb-bg: #0a0a0a;
  --lb-bg-elev: #141414;
  --lb-bg-sunken: #050505;

  --lb-text: #fafafa;
  --lb-text-2: #a1a1aa;
  --lb-text-3: #71717a;

  --lb-border: rgba(255, 255, 255, 0.08);
  --lb-border-strong: rgba(255, 255, 255, 0.16);

  --lb-accent: #fafafa;
  --lb-accent-fg: #0a0a0a;
  --lb-accent-hover: #e4e4e7;
  --lb-accent-active: #d4d4d8;

  --lb-success: #34d399;
  --lb-warning: #fbbf24;
  --lb-danger: #f87171;
  --lb-info: #60a5fa;

  --lb-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
  --lb-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  --lb-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.6);
}
```

- [ ] **Step 6: Replace the helper-class block**

Replace lines 181–214 (the `/* ─── Reusable Apple-style primitives ─── */` block through end-of-file) with:

```css
/* ─── Reusable industrial primitives ────────────────────────────────────
   Helper classes pages can use directly. Subsequent plans will replace
   most usages with React primitives in src/components/ui/. */

.lb-glass {
  background: var(--lb-bg-elev);
  border-bottom: 1px solid var(--lb-border);
}

.lb-card {
  background: var(--lb-bg-elev);
  border: 1px solid var(--lb-border);
  border-radius: var(--lb-radius);
  box-shadow: var(--lb-shadow-sm);
}

.lb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--lb-radius-sm);
  font-family: var(--lb-font-text);
  font-size: var(--lb-text-13);
  font-weight: 500;
  border: 1px solid var(--lb-border-strong);
  background: var(--lb-bg-elev);
  color: var(--lb-text);
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  letter-spacing: -0.005em;
  height: 32px;
}
.lb-btn:hover {
  background: var(--lb-bg-sunken);
}
.lb-btn:active {
  background: var(--lb-bg-sunken);
  border-color: var(--lb-border-strong);
}
.lb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.lb-btn-primary {
  background: var(--lb-accent);
  border-color: var(--lb-accent);
  color: var(--lb-accent-fg);
}
.lb-btn-primary:hover {
  background: var(--lb-accent-hover);
  border-color: var(--lb-accent-hover);
}
.lb-btn-primary:active {
  background: var(--lb-accent-active);
}

.lb-btn-ghost {
  border-color: transparent;
  background: transparent;
}
.lb-btn-ghost:hover {
  background: var(--lb-bg-sunken);
}

.lb-input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--lb-border-strong);
  border-radius: var(--lb-radius-xs);
  background: var(--lb-bg-elev);
  color: var(--lb-text);
  font-family: var(--lb-font-text);
  font-size: var(--lb-text-13);
  letter-spacing: -0.005em;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.lb-input:focus {
  outline: none;
  border-color: var(--lb-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--lb-accent) 18%, transparent);
}

.lb-label {
  font-size: var(--lb-text-12);
  font-weight: 500;
  color: var(--lb-text-2);
  letter-spacing: -0.005em;
}

/* Mono utility — for SKUs, IDs, codes */
.lb-mono {
  font-family: var(--lb-font-mono);
  font-feature-settings: "tnum" 1;
}
```

- [ ] **Step 7: Verify type-check + lint**

Run `npx tsc --noEmit` then `npm run lint`. Both should pass — `globals.css` is not type-checked but the lint may flag class usage if any consumer is broken.

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

- [ ] **Step 8: Visual smoke**

Run `npm run dev`, browse `/` while signed out. The page should render — text near-black, surfaces white, no pill buttons, no Apple-blue highlights. Existing pages will look transitional (some legacy layouts assume Apple-blue) but nothing should crash.

- [ ] **Step 9: Commit**

```bash
git add src/app/globals.css
git commit -m "redesign: rewrite tokens and helper classes for industrial palette

Replaces the Apple-inspired tokens with the industrial / operational
palette defined in
docs/superpowers/specs/2026-05-05-frontend-redesign-industrial-design.md.

Helper classes (.lb-btn, .lb-input, .lb-card, .lb-glass) are rewritten
in place so existing pages inherit the new look without per-page edits.
shadcn vars in :root and .dark mirror the same token values."
```

---

### Task 4: Create `src/lib/theme.ts` (no-FOUC theme apply)

**Files:**
- Create: `src/lib/theme.ts`

- [ ] **Step 1: Write the file**

```typescript
// Resolves the user's theme preference (stored | system) and toggles the
// `dark` class on <html>. Called twice:
//   1. As an inline <script> in <head> on initial render to avoid FOUC.
//   2. From <ThemeToggle> in the client when the user changes preference.

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "lb-theme";

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice === "light" || choice === "dark") return choice;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(choice);
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function readStoredTheme(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

export function writeStoredTheme(choice: ThemeChoice): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(THEME_STORAGE_KEY, choice);
}

// String form for the inline <script> in app/layout.tsx — kept here so it
// stays in sync with the runtime helpers above.
export const NO_FOUC_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var c=localStorage.getItem(k);if(c!=='light'&&c!=='dark'&&c!=='system')c='system';var d=c==='dark'||(c==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(_){}})();`;
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/theme.ts
git commit -m "redesign: add theme helper (resolve / apply / persist + no-FOUC script)"
```

---

### Task 5: Create `ThemeToggle.tsx`

**Files:**
- Create: `src/components/ThemeToggle.tsx`

- [ ] **Step 1: Write the file**

```typescript
"use client";

import { useEffect, useState } from "react";
import {
  applyTheme,
  readStoredTheme,
  writeStoredTheme,
  type ThemeChoice,
} from "@/lib/theme";

const ICONS: Record<ThemeChoice, string> = {
  light: "☀",
  dark: "☾",
  system: "⌬",
};

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  light: "dark",
  dark: "system",
  system: "light",
};

export default function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = readStoredTheme();
    setChoice(stored);
    applyTheme(stored);
  }, []);

  function cycle() {
    const next = NEXT[choice];
    setChoice(next);
    writeStoredTheme(next);
    applyTheme(next);
  }

  return (
    <button
      type="button"
      aria-label={`Theme: ${choice} (click to change)`}
      title={`Theme: ${choice}`}
      onClick={cycle}
      className="lb-btn lb-btn-ghost"
      style={{ width: 32, padding: 0 }}
    >
      <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
        {ICONS[choice]}
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/ThemeToggle.tsx
git commit -m "redesign: add ThemeToggle (light / dark / system cycle)"
```

---

### Task 6: Create `Breadcrumbs.tsx`

**Files:**
- Create: `src/components/Breadcrumbs.tsx`

- [ ] **Step 1: Write the file**

```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Static map. Add entries here as new routes ship.
const ROUTE_LABELS: Record<string, string> = {
  "": "Home",
  suppliers: "Inventory & Manufacturing",
  competitors: "Competitors & Market Research",
  handbook: "Process",
  engineering: "Engineering",
  admin: "Admin",
  "sign-in": "Sign in",
  "sign-up": "Sign up",
};

export default function Breadcrumbs() {
  const pathname = usePathname() ?? "/";
  const segments = pathname.split("/").filter(Boolean);

  // Build crumb objects with hrefs.
  const crumbs = segments.map((seg, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    const label = ROUTE_LABELS[seg] ?? seg;
    return { href, label };
  });

  // Always anchor with Home.
  const all = [{ href: "/", label: "Home" }, ...crumbs];

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
      {all.map((c, i) => {
        const last = i === all.length - 1;
        return (
          <span key={c.href} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && (
              <span
                aria-hidden
                style={{ color: "var(--lb-text-3)", fontSize: 12 }}
              >
                /
              </span>
            )}
            {last ? (
              <span
                className="truncate"
                style={{
                  color: "var(--lb-text)",
                  fontSize: "var(--lb-text-13)",
                  fontWeight: 500,
                }}
              >
                {c.label}
              </span>
            ) : (
              <Link
                href={c.href}
                className="truncate"
                style={{
                  color: "var(--lb-text-2)",
                  fontSize: "var(--lb-text-13)",
                }}
              >
                {c.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/Breadcrumbs.tsx
git commit -m "redesign: add Breadcrumbs derived from pathname"
```

---

### Task 7: Create `SidebarItem.tsx`

**Files:**
- Create: `src/components/SidebarItem.tsx`

- [ ] **Step 1: Write the file**

```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = {
  href: string;
  icon: string; // single character / emoji / svg-as-text — replace with lucide later
  label: string;
  collapsed: boolean;
  exact?: boolean; // match only on exact pathname; default false (prefix match)
};

export default function SidebarItem({
  href,
  icon,
  label,
  collapsed,
  exact = false,
}: Props) {
  const pathname = usePathname() ?? "/";
  const active = exact
    ? pathname === href
    : pathname === href || pathname.startsWith(href + "/");

  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className="flex items-center gap-3 rounded-[var(--lb-radius-sm)] px-3 h-9 transition-colors"
      style={{
        color: active ? "var(--lb-text)" : "var(--lb-text-2)",
        background: active ? "var(--lb-bg-sunken)" : "transparent",
        fontSize: "var(--lb-text-13)",
        fontWeight: active ? 600 : 500,
        letterSpacing: "-0.005em",
      }}
    >
      <span
        aria-hidden
        className="inline-flex items-center justify-center shrink-0"
        style={{ width: 16, height: 16, fontSize: 14 }}
      >
        {icon}
      </span>
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/SidebarItem.tsx
git commit -m "redesign: add SidebarItem (active state + collapsed icon-only mode)"
```

---

### Task 8: Create `Sidebar.tsx`

**Files:**
- Create: `src/components/Sidebar.tsx`

- [ ] **Step 1: Write the file**

```typescript
"use client";

import Link from "next/link";
import SidebarItem from "./SidebarItem";

type Props = {
  collapsed: boolean;
  email: string | null;
  role: string | null;
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  isAdmin: boolean;
};

type Item = {
  href: string;
  icon: string;
  label: string;
  show: boolean;
};

export default function Sidebar({
  collapsed,
  email,
  role,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
}: Props) {
  const items: Item[] = [
    { href: "/suppliers", icon: "▢", label: "Inventory & Manufacturing", show: canViewSuppliers },
    { href: "/competitors", icon: "◊", label: "Competitors & Market Research", show: canViewCompetitors },
    { href: "/handbook", icon: "≡", label: "Process", show: canViewHandbook },
    { href: "/engineering", icon: "⚙", label: "Engineering", show: canViewEngineering },
    { href: "/admin", icon: "★", label: "Admin", show: isAdmin },
  ];

  const width = collapsed ? "var(--lb-sidebar-collapsed-w)" : "var(--lb-sidebar-w)";

  return (
    <aside
      className="flex flex-col shrink-0 border-r"
      style={{
        width,
        borderColor: "var(--lb-border)",
        background: "var(--lb-bg-elev)",
        transition: "width 160ms ease",
      }}
    >
      {/* Brand */}
      <Link
        href="/"
        className="flex items-center gap-2 h-12 px-3 border-b shrink-0"
        style={{
          borderColor: "var(--lb-border)",
          color: "var(--lb-text)",
          fontWeight: 600,
          letterSpacing: "-0.015em",
          fontSize: "var(--lb-text-15)",
        }}
        title="Lightbase"
      >
        <span
          aria-hidden
          className="inline-block shrink-0"
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            background: "var(--lb-accent)",
          }}
        />
        {!collapsed && <span>Lightbase</span>}
      </Link>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-0.5">
        {items
          .filter((i) => i.show)
          .map((i) => (
            <SidebarItem
              key={i.href}
              href={i.href}
              icon={i.icon}
              label={i.label}
              collapsed={collapsed}
            />
          ))}
      </nav>

      {/* User pill */}
      {email && (
        <div
          className="border-t px-3 py-3 flex items-center gap-2 shrink-0"
          style={{ borderColor: "var(--lb-border)" }}
        >
          <span
            aria-hidden
            className="inline-flex items-center justify-center shrink-0 rounded-full"
            style={{
              width: 28,
              height: 28,
              background: "var(--lb-bg-sunken)",
              color: "var(--lb-text-2)",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {email.slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div
                className="truncate"
                style={{
                  color: "var(--lb-text)",
                  fontSize: "var(--lb-text-13)",
                  fontWeight: 500,
                }}
              >
                {email}
              </div>
              {role && role !== "member" && (
                <div
                  className="truncate uppercase"
                  style={{
                    color: "var(--lb-text-3)",
                    fontSize: "var(--lb-text-12)",
                    letterSpacing: "0.04em",
                  }}
                >
                  {role}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "redesign: add Sidebar (collapsible, role-gated nav, user pill)"
```

---

### Task 9: Create `TopBar.tsx`

**Files:**
- Create: `src/components/TopBar.tsx`

- [ ] **Step 1: Write the file**

```typescript
"use client";

import { Show, UserButton, SignInButton, SignUpButton } from "@clerk/nextjs";
import Breadcrumbs from "./Breadcrumbs";
import ThemeToggle from "./ThemeToggle";

type Props = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export default function TopBar({ collapsed, onToggleCollapsed }: Props) {
  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-3 px-3 border-b shrink-0"
      style={{
        height: "var(--lb-topbar-h)",
        borderColor: "var(--lb-border)",
        background: "var(--lb-bg-elev)",
      }}
    >
      <button
        type="button"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={onToggleCollapsed}
        className="lb-btn lb-btn-ghost"
        style={{ width: 32, padding: 0 }}
      >
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
          {collapsed ? "›" : "‹"}
        </span>
      </button>
      <div className="flex-1 min-w-0">
        <Breadcrumbs />
      </div>
      <ThemeToggle />
      <Show when="signed-out">
        <SignInButton>
          <button className="lb-btn lb-btn-ghost">Sign in</button>
        </SignInButton>
        <SignUpButton>
          <button className="lb-btn lb-btn-primary">Get started</button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </header>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/TopBar.tsx
git commit -m "redesign: add TopBar (collapse toggle, breadcrumbs, theme, user)"
```

---

### Task 10: Create `AppShell.tsx`

**Files:**
- Create: `src/components/AppShell.tsx`

- [ ] **Step 1: Write the file**

```typescript
"use client";

import { useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";

const COLLAPSE_STORAGE_KEY = "lb-sidebar-collapsed";

type Props = {
  email: string | null;
  role: string | null;
  canViewSuppliers: boolean;
  canViewCompetitors: boolean;
  canViewHandbook: boolean;
  canViewEngineering: boolean;
  isAdmin: boolean;
  children: React.ReactNode;
};

export default function AppShell({
  email,
  role,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  isAdmin,
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const v = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (v === "1") setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <Sidebar
        collapsed={collapsed}
        email={email}
        role={role}
        canViewSuppliers={canViewSuppliers}
        canViewCompetitors={canViewCompetitors}
        canViewHandbook={canViewHandbook}
        canViewEngineering={canViewEngineering}
        isAdmin={isAdmin}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "redesign: add AppShell composing Sidebar + TopBar with collapse state"
```

---

### Task 11: Update `app/layout.tsx` to use `AppShell`

**Files:**
- Modify: `src/app/layout.tsx` (full file rewrite)

- [ ] **Step 1: Read the current layout**

Confirm the imports + structure match the snapshot in the spec exploration.

- [ ] **Step 2: Replace the file**

Overwrite `src/app/layout.tsx` with:

```typescript
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import AppShell from "@/components/AppShell";
import { NO_FOUC_SCRIPT } from "@/lib/theme";
import {
  getOrCreateProfile,
  isAdmin,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
} from "@/lib/permissions";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lightbase — Operations",
  description:
    "Internal operations console: suppliers, inventory, manufacturing, and competitor intelligence.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const profile = await getOrCreateProfile();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          // No-FOUC: applies the persisted theme before first paint.
          dangerouslySetInnerHTML={{ __html: NO_FOUC_SCRIPT }}
        />
      </head>
      <body
        className="min-h-full"
        style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
      >
        <ClerkProvider>
          {profile ? (
            <AppShell
              email={profile.email}
              role={profile.role}
              canViewSuppliers={canViewSuppliers(profile)}
              canViewCompetitors={canViewCompetitors(profile)}
              canViewHandbook={canViewHandbook(profile)}
              canViewEngineering={canViewEngineering(profile)}
              isAdmin={isAdmin(profile)}
            >
              {children}
            </AppShell>
          ) : (
            // Signed-out users: no shell, just the page (sign-in / landing).
            <div
              className="min-h-screen w-full flex flex-col"
              style={{ background: "var(--lb-bg)" }}
            >
              {children}
            </div>
          )}
        </ClerkProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: pass. If `@clerk/nextjs` types complain about `<Show>` no longer being imported here, that's expected — `<Show>` moved to `TopBar`.

- [ ] **Step 4: Commit**

```bash
git add src/app/layout.tsx
git commit -m "redesign: wrap children in AppShell, inject no-FOUC theme script"
```

---

### Task 12: Delete `src/components/TopNav.tsx`

**Files:**
- Delete: `src/components/TopNav.tsx`

- [ ] **Step 1: Confirm no remaining imports**

Run: `grep -r "from \"@/components/TopNav\"" src` (or use Grep tool with pattern `from "@/components/TopNav"`).
Expected: zero hits.

- [ ] **Step 2: Delete**

```bash
git rm src/components/TopNav.tsx
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "redesign: remove obsolete TopNav (replaced by Sidebar)"
```

---

### Task 13: Full validation pass

**Files:**
- (no edits — verification only)

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: zero errors. Warnings related to pre-existing pages are acceptable in this plan; capture them in the commit body if any are unrelated to foundation files.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: success. If any page fails to build because it imports a now-removed token (e.g., references `--lb-radius-pill` semantically as "pill"), note it but do NOT fix it here — the legacy alias preserves the pill key, and follow-up plans will rebuild those pages.

- [ ] **Step 4: Dev-server visual smoke**

Run: `npm run dev` in a background terminal. Open `http://localhost:3000` and verify:

| Route | What to see |
|---|---|
| `/` (signed out) | No shell. Centered hero text. New token palette (off-white bg, near-black text). |
| `/sign-in` | No shell. Clerk component still renders. |
| `/` (signed in, member) | Shell visible. Sidebar with "Inventory & Manufacturing" / "Competitors..." entries gated by role. TopBar with breadcrumb "Home", theme toggle, user button. |
| `/suppliers` (with permission) | Shell + breadcrumb "Inventory & Manufacturing". Page contents look transitional (existing page content, new chrome). |
| `/competitors` (with permission) | Shell + correct breadcrumb. |
| Sidebar collapse toggle | Click `‹` in TopBar → sidebar shrinks to 56px, brand mark visible, labels hidden. Click `›` → expands. State persists across reload. |
| Theme toggle | Click → cycles light → dark → system → light. Tokens swap without flicker on reload. |

- [ ] **Step 5: Commit verification notes (only if anything was tweaked)**

If any of the above produced a small regression you fixed inline (e.g., a missing `key` prop, a TS narrowing fix), commit those fixes individually with `redesign: fix <thing>` messages. Otherwise skip this step.

---

### Task 14: Update spec status + final foundation commit

**Files:**
- Modify: `docs/superpowers/specs/2026-05-05-frontend-redesign-industrial-design.md` (status line at top)

- [ ] **Step 1: Mark Phase 1 complete in the spec**

Change the second line of the spec from `**Status:** Draft for review` to:

```markdown
**Status:** Phase 0 + Phase 1 complete (Stitch system + tokens + shell). Phases 2-4 in follow-up plans.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-05-frontend-redesign-industrial-design.md
git commit -m "redesign: mark foundation phases complete in spec"
```

- [ ] **Step 3: Decision point — next plan**

Foundation done. Existing pages render inside the new shell with the new tokens, but their internals (tables, forms, drawers) still use legacy markup. Confirm direction for Plan 2 with the user:

- **Plan 2 (recommended):** Build the primitive component library in `src/components/ui/` (Button, Input, Select, Table, StatusPill, Card, Drawer, Modal, Tabs, EmptyState, Toast, Tooltip, Avatar, Badge, KeyValue) using the Stitch reference screens.
- Alternative: jump directly into rebuilding the Suppliers cluster with inline styling, defer the primitive library.

Default to recommended unless the user redirects.

---

## Self-review notes

After writing this plan, the author cross-checked it against the spec:

- **Phase 0 (Stitch design system + reference screens)** → Tasks 1, 2.
- **Phase 1 (Tokens + shell)** → Tasks 3 (tokens + helpers), 4–10 (shell components), 11 (layout integration), 12 (TopNav removal), 13 (validation).
- **Phase 2 (Primitive library)** → deferred to Plan 2 (out-of-scope statement up top).
- **Phase 3 (Page rebuilds)** → deferred to Plans 3–5 (out-of-scope statement up top).
- **Phase 4 (Polish: dark mode, mobile, charts, Clerk theming)** → deferred to Plan 6 (out-of-scope statement up top). Note that dark mode tokens and the `ThemeToggle` ship in this plan; dark-mode *page-level* polish is what's deferred.
- **Color tokens** match the spec table exactly (light + dark, including status colors).
- **Type scale, geometry, layout** vars match the spec.
- **Functionality preservation** is enforced by the design: pages aren't edited in this plan, only the shell around them and the helper classes they consume.
- No placeholders, no "TBD"s, no unimplemented references between tasks. Type names (`ThemeChoice`, `Item`, prop names on `AppShell` / `Sidebar` / `TopBar`) are consistent across tasks.
- Test loop choice (TS + lint + build + visual) is justified up front and applied uniformly.

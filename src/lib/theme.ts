// Resolves the user's theme preference (stored | system | dark default) and
// toggles the `dark` class on <html>. Called twice:
//   1. As an inline <script> in <head> on initial render to avoid FOUC.
//   2. From <ThemeToggle> in the client when the user changes preference.
//
// "system" follows the OS; if no value is stored, the app defaults to dark
// (the SaaS dashboard look the design targets).

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "lb-theme";

/** When no preference is stored, use this. */
export const DEFAULT_THEME: ThemeChoice = "dark";

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice === "light" || choice === "dark") return choice;
  if (typeof window === "undefined") return "dark";
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
  if (typeof window === "undefined") return DEFAULT_THEME;
  const v = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return DEFAULT_THEME;
}

export function writeStoredTheme(choice: ThemeChoice): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(THEME_STORAGE_KEY, choice);
}

// String form for the inline <script> in app/layout.tsx — kept here so it
// stays in sync with the runtime helpers above. Defaults to dark when no
// preference has been stored yet.
export const NO_FOUC_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var c=localStorage.getItem(k);if(c!=='light'&&c!=='dark'&&c!=='system')c='${DEFAULT_THEME}';var d=c==='dark'||(c==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(_){document.documentElement.classList.add('dark');}})();`;

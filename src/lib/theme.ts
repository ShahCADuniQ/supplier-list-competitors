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

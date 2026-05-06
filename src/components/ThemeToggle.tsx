"use client";

import { useState } from "react";
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
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const stored = readStoredTheme();
    applyTheme(stored);
    return stored;
  });

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

"use client";

// Wraps an iframe and pipes the parent app's theme into it.
//
//   1. On mount, reads `localStorage["lb-theme"]` and appends it to the iframe
//      src as `?theme=...` so the iframe's own startup script picks it up
//      before first paint.
//   2. Watches `<html>.classList` for changes (the ThemeToggle flips the
//      `dark` class on document.documentElement). On change, postMessage the
//      iframe with `{ type: "lb-theme", value: "light"|"dark"|"system" }`.
//
// The iframe's HTML must include a small script that:
//   - resolves theme from URL query, parent.localStorage, or prefers-color-scheme
//   - applies a `dark` class to its own <html>
//   - listens for the postMessage shape above

import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  title: string;
  className?: string;
  style?: React.CSSProperties;
};

type ThemeChoice = "light" | "dark" | "system";

function readStored(): ThemeChoice {
  if (typeof window === "undefined") return "dark";
  const v = window.localStorage.getItem("lb-theme");
  if (v === "light" || v === "dark" || v === "system") return v;
  return "dark";
}

function currentResolvedFromHtml(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export default function ThemedIframe({ src, title, className, style }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);

  useEffect(() => {
    // On mount: append the stored choice as ?theme= so the iframe knows
    // before its own JS reads parent.localStorage.
    const stored = readStored();
    const url = new URL(src, window.location.origin);
    url.searchParams.set("theme", stored);
    setResolvedSrc(url.pathname + url.search);
  }, [src]);

  useEffect(() => {
    // Watch the parent <html>.dark class for changes; pipe to iframe.
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const iframe = ref.current;
      if (!iframe || !iframe.contentWindow) return;
      const value: ThemeChoice = currentResolvedFromHtml(); // light | dark
      try {
        iframe.contentWindow.postMessage({ type: "lb-theme", value }, "*");
      } catch {
        // ignore — same-origin iframe should accept this
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  if (!resolvedSrc) {
    // First render (server / pre-hydration): render with the original src
    // so static SSR works. The effect above will re-render with theme query
    // before the iframe is interacted with.
    return (
      <iframe
        ref={ref}
        src={src}
        title={title}
        className={className}
        style={style}
      />
    );
  }

  return (
    <iframe
      ref={ref}
      src={resolvedSrc}
      title={title}
      className={className}
      style={style}
    />
  );
}

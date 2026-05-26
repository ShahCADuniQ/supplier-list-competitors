"use client";

import { useEffect, useRef, useState } from "react";

// Smart sticky nav: hides when the user scrolls down past the top of
// the page, reappears when they scroll up. At the very top (scrollY
// near 0) the bar is fully visible AND transparent so the hero gradient
// bleeds through unimpeded; the moment the user starts scrolling and
// the bar re-enters, it gets a solid surface (white in light mode,
// near-black in dark mode via --lb-bg) so the content underneath
// doesn't show through and clash with the logo / CTAs.
//
// Tiny dead-band on scroll-delta (THRESHOLD) keeps the bar from
// flickering on trackpad inertia or tiny jitters.

const THRESHOLD = 6;
const AT_TOP_PX = 8;

export default function ScrollAwareTopNav({
  children,
  padding = "14px clamp(16px, 4vw, 28px)",
}: {
  children: React.ReactNode;
  // Override the default padding if a particular page needs different
  // gutters (e.g. tighter on auth pages).
  padding?: string;
}) {
  const [visible, setVisible] = useState(true);
  const [atTop, setAtTop] = useState(true);
  const lastScrollRef = useRef(0);

  useEffect(() => {
    lastScrollRef.current = window.scrollY;

    function onScroll() {
      const current = window.scrollY;
      const last = lastScrollRef.current;
      const goingDown = current > last + THRESHOLD;
      const goingUp = current < last - THRESHOLD;
      const nearTop = current <= AT_TOP_PX;

      if (nearTop) {
        setVisible(true);
        setAtTop(true);
      } else if (goingDown) {
        setVisible(false);
        setAtTop(false);
      } else if (goingUp) {
        setVisible(true);
        setAtTop(false);
      }

      if (goingDown || goingUp) {
        lastScrollRef.current = current;
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      aria-label="Primary"
      style={{
        // sticky (not fixed) so the bar occupies its natural slot at
        // the top of the document — that way the hero below isn't
        // shifted under it, and the transparent at-top state has no
        // page content visible behind the logo / CTAs. As soon as the
        // user scrolls, the nav stays glued to the viewport top.
        position: "sticky",
        top: 0,
        zIndex: 50,
        padding,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        transform: visible ? "translateY(0)" : "translateY(-110%)",
        background: atTop ? "transparent" : "var(--lb-bg)",
        borderBottom: atTop
          ? "1px solid transparent"
          : "1px solid var(--lb-border)",
        transition:
          "transform 240ms ease, background 220ms ease, border-color 220ms ease",
        willChange: "transform",
      }}
    >
      {children}
    </nav>
  );
}

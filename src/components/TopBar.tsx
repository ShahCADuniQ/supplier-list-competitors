"use client";

import { Show, UserButton, SignInButton, SignUpButton } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";

const TITLE_BY_PREFIX: { prefix: string; title: string }[] = [
  { prefix: "/suppliers", title: "INVENTORY" },
  { prefix: "/competitors", title: "COMPETITORS" },
  { prefix: "/handbook", title: "PROCESS" },
  { prefix: "/engineering", title: "ENGINEERING" },
  { prefix: "/admin", title: "ADMIN" },
  { prefix: "/sign-in", title: "SIGN IN" },
  { prefix: "/sign-up", title: "SIGN UP" },
];

function pageTitle(pathname: string): string {
  const match = TITLE_BY_PREFIX.find(
    (m) => pathname === m.prefix || pathname.startsWith(m.prefix + "/"),
  );
  return match?.title ?? "LIGHTBASE";
}

export default function TopBar() {
  const pathname = usePathname() ?? "/";
  const title = pageTitle(pathname);

  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-4 px-6 shrink-0"
      style={{
        height: "var(--lb-topbar-h)",
        background: "var(--lb-bg)",
      }}
    >
      <h1
        style={{
          fontFamily: "var(--lb-font-display)",
          fontSize: 26,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color: "var(--lb-text)",
          textTransform: "uppercase",
          flexShrink: 0,
          margin: 0,
        }}
      >
        {title}
      </h1>

      {/* Pill search slot */}
      <div className="flex-1 max-w-xl" role="search" aria-label="Search">
        <div
          className="flex items-center gap-2 px-4"
          style={{
            height: 40,
            borderRadius: "var(--lb-radius-pill)",
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
          }}
        >
          <span aria-hidden style={{ fontSize: 14, color: "var(--lb-text-3)" }}>
            ⌕
          </span>
          <input
            type="search"
            placeholder="Search…"
            className="flex-1 bg-transparent outline-none"
            style={{
              color: "var(--lb-text)",
              fontSize: "var(--lb-text-14)",
              border: "none",
              padding: 0,
              minWidth: 0,
            }}
          />
        </div>
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

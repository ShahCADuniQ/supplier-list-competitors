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

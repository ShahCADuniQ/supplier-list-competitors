// Post-claim onboarding step: connect your work mailbox in one click.
//
// New users land here right after their role-claim (engineering /
// supplier / retailer) succeeds. We auto-detect their provider from
// their email domain — if it's a known consumer provider or a corporate
// domain we have mapped, we show ONE big button that pre-fills their
// address on the consent screen. Otherwise we show both options.
//
// "Skip for now" drops a cookie so we don't re-prompt them on every
// signed-in page hit; they can still come back via Settings later.

import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getOrCreateProfile, isCaduniqUser } from "@/lib/permissions";
import { hasUserEmailConnection } from "@/lib/email";
import { detectEmailProvider } from "@/lib/email/detect-provider";
import { getTenantIntegrationState } from "@/lib/email/integration-requests";
import { getEmailSetupStatus, isProviderReady } from "@/app/settings/email/setup-status";
import CaduniqLogo from "@/components/CaduniqLogo";
import ThemeToggle from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";

export const EMAIL_PROMPT_COOKIE = "lb_email_prompt_dismissed";

export default async function ConnectEmailStep({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");

  const params = await searchParams;
  const nextUrl = params.next && params.next.startsWith("/") ? params.next : "/";

  // If they already connected, don't make them sit through this again.
  if (await hasUserEmailConnection(profile.clerkUserId)) {
    redirect(nextUrl);
  }
  // Or if they explicitly dismissed it within the cookie window.
  const jar = await cookies();
  if (jar.get(EMAIL_PROMPT_COOKIE)?.value === "1") {
    redirect(nextUrl);
  }

  const setup = await getEmailSetupStatus();
  const nylasReady = isProviderReady(setup);

  // Per-tenant approval gate. If the tenant hasn't been approved yet,
  // skip this step entirely — the user will see the Request prompt on
  // the home page card instead. CADuniQ staff bypass.
  if (!isCaduniqUser(profile) && profile.clientId != null) {
    const tenantState = await getTenantIntegrationState(profile.clientId);
    if (tenantState?.status !== "approved") {
      redirect(nextUrl);
    }
  }

  // Even when Nylas isn't configured (admin hasn't set NYLAS_CLIENT_ID),
  // we still show the page so the user knows the connection is coming,
  // but the buttons are disabled.

  const detected = detectEmailProvider(profile.email);
  const email = profile.email ?? "";
  const startHref = (provider: "microsoft" | "google") =>
    `/api/email/oauth/${provider}/start${email ? `?email=${encodeURIComponent(email)}` : ""}`;

  return (
    <div
      className="flex min-h-screen w-full flex-col"
      style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
    >
      <header
        className="sticky top-0 z-30 flex items-center justify-between px-6"
        style={{ height: "var(--lb-topbar-h)", background: "transparent" }}
      >
        <CaduniqLogo href="/" height={60} />
        <ThemeToggle />
      </header>

      <main
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "32px 20px",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 560,
            background: "var(--lb-bg-elev)",
            border: "1px solid var(--lb-border)",
            borderRadius: 16,
            padding: 32,
            boxShadow: "0 8px 32px rgba(0,0,0,0.06)",
          }}
        >
          <div
            aria-hidden
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              background: "rgba(37,99,235,0.12)",
              color: "#2563eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
              marginBottom: 18,
            }}
          >
            ✉
          </div>

          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.01em" }}>
            Connect your work email
          </h1>
          <p
            style={{
              marginTop: 8,
              marginBottom: 0,
              fontSize: 14,
              color: "var(--lb-text-3)",
              lineHeight: 1.55,
            }}
          >
            One click and you&apos;re done — RFQs you send from CADuniQ
            will arrive from <strong>{email || "your address"}</strong>,
            supplier replies thread back into your real inbox, and your
            home page shows a summary of order activity.
          </p>

          {!nylasReady && (
            <div
              style={{
                marginTop: 18,
                padding: 12,
                borderRadius: 8,
                background: "rgba(234,88,12,0.10)",
                border: "1px solid rgba(234,88,12,0.40)",
                color: "#ea580c",
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            >
              Email connection isn&apos;t available yet — an administrator
              still needs to finish a one-time Nylas setup. You can skip
              this for now and connect from <strong>Settings</strong>{" "}
              once it&apos;s ready.
            </div>
          )}

          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
            {detected === "microsoft" ? (
              <>
                <ProviderButton
                  primary
                  ready={nylasReady}
                  href={startHref("microsoft")}
                  brand="Connect Outlook / Microsoft 365"
                  hint={`We detected ${email} is a Microsoft account`}
                  color="#0078D4"
                />
                <ProviderButton
                  ready={nylasReady}
                  href={startHref("google")}
                  brand="Use a Gmail account instead"
                  hint="Google Workspace or @gmail.com"
                  color="#EA4335"
                />
              </>
            ) : detected === "google" ? (
              <>
                <ProviderButton
                  primary
                  ready={nylasReady}
                  href={startHref("google")}
                  brand="Connect Gmail / Google Workspace"
                  hint={`We detected ${email} is a Google account`}
                  color="#EA4335"
                />
                <ProviderButton
                  ready={nylasReady}
                  href={startHref("microsoft")}
                  brand="Use an Outlook account instead"
                  hint="Microsoft 365 or @outlook.com"
                  color="#0078D4"
                />
              </>
            ) : (
              <>
                <ProviderButton
                  primary
                  ready={nylasReady}
                  href={startHref("microsoft")}
                  brand="Connect Outlook / Microsoft 365"
                  hint="If your work email is on Microsoft 365"
                  color="#0078D4"
                />
                <ProviderButton
                  primary
                  ready={nylasReady}
                  href={startHref("google")}
                  brand="Connect Gmail / Google Workspace"
                  hint="If your work email is on Google"
                  color="#EA4335"
                />
              </>
            )}
          </div>

          <div
            style={{
              marginTop: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12.5,
            }}
          >
            <span style={{ color: "var(--lb-text-3)" }}>
              We request read + send only. Tokens are encrypted at rest.
            </span>
            <form action={skipForNow}>
              <input type="hidden" name="next" value={nextUrl} />
              <button
                type="submit"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--lb-text-3)",
                  fontSize: 13,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Skip for now
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

function ProviderButton({
  href,
  brand,
  hint,
  ready,
  color,
  primary,
}: {
  href: string;
  brand: string;
  hint: string;
  ready: boolean;
  color: string;
  primary?: boolean;
}) {
  const base: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "14px 16px",
    borderRadius: 12,
    textDecoration: "none",
    color: "var(--lb-text)",
    background: primary
      ? "linear-gradient(135deg, var(--lb-bg) 0%, var(--lb-bg-elev) 100%)"
      : "var(--lb-bg)",
    border: primary
      ? "1px solid var(--lb-accent)"
      : "1px solid var(--lb-border)",
    boxShadow: primary ? "0 1px 3px rgba(0,0,0,0.04)" : "none",
  };
  if (!ready) {
    return (
      <span aria-disabled style={{ ...base, opacity: 0.55, cursor: "not-allowed" }}>
        <ProviderDot color={color} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{brand}</div>
          <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 2 }}>
            Not configured
          </div>
        </div>
      </span>
    );
  }
  return (
    <Link href={href} style={base}>
      <ProviderDot color={color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{brand}</div>
        <div style={{ fontSize: 11.5, color: "var(--lb-text-3)", marginTop: 2 }}>
          {hint}
        </div>
      </div>
      <span style={{ fontSize: 14, color: "var(--lb-text-2)" }}>→</span>
    </Link>
  );
}

function ProviderDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        background: color,
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}

async function skipForNow(formData: FormData) {
  "use server";
  const next =
    (formData.get("next") as string | null)?.toString() || "/";
  const safeNext = next.startsWith("/") ? next : "/";
  const jar = await cookies();
  // 30-day dismissal — long enough that we don't pester returning users,
  // short enough that they get re-prompted occasionally if they never
  // connected. The Settings page is still always available.
  jar.set(EMAIL_PROMPT_COOKIE, "1", {
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
  });
  redirect(safeNext);
}

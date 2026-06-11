// Legacy /settings/email — the email section now lives inside the
// unified Manage Account page at /settings. Redirect so existing
// links (compose-dialog banners, the OAuth callback's success URL,
// outbound bookmarks) keep landing on the right surface.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LegacyEmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string }>;
}) {
  const params = await searchParams;
  const qs = params.connected
    ? `?connected=${encodeURIComponent(params.connected)}#email`
    : "#email";
  redirect(`/settings${qs}`);
}

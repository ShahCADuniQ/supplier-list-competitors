import { NextResponse, type NextRequest } from "next/server";
import { getOrCreateProfile, isAdmin } from "@/lib/permissions";

// Diagnostic endpoint for the "Pinterest extract works locally but not on
// Vercel" failure pattern. Reproduces the EXACT fetch the production
// extractor (`src/lib/ai/pinterest.ts`) makes, plus probes the function's
// outbound IP so we can see what Pinterest sees.
//
// Why this exists: server actions that fail on Vercel surface as the
// generic "Server Components render" error in production builds — the
// real cause (status code, blocked body, etc.) never reaches the client.
// This endpoint surfaces it directly.
//
// Auth: admin-only. The endpoint hits arbitrary URLs server-side, so we
// don't want it open to anyone signed in.
//
// Usage (after deploy):
//   GET /api/_diag/pinterest?url=https://www.pinterest.com/pin/12345/
//
// Output (JSON):
//   {
//     outboundIp: "76.76.21.xx",            // what Pinterest sees
//     pinterest: {
//       status: 200,
//       statusText: "OK",
//       finalUrl: "...",                     // after redirects
//       headers: {...},                      // response headers (subset)
//       bodyBytes: 9123,
//       imageUrlCount: 0,                    // i.pinimg.com URL hits in body
//       hasLoginMarker: true,                // "log in" / "sign up" in body
//       hasCaptchaMarker: false,             // CAPTCHA / cf-challenge markers
//       bodyPreview: "..."                   // first 500 chars of body
//     },
//     ms: 412
//   }

export const dynamic = "force-dynamic";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export async function GET(request: NextRequest) {
  const profile = await getOrCreateProfile();
  if (!profile)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(profile))
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });

  const url = request.nextUrl.searchParams.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json(
      { error: "Provide a ?url= query parameter starting with http(s)://" },
      { status: 400 },
    );
  }

  const t0 = Date.now();

  // Probe outbound IP in parallel — tells us what Pinterest sees as the
  // client. Vercel functions tend to land in a few well-known AWS ranges
  // (76.76.21.0/24 for iad1, etc.) that Pinterest is known to filter.
  const ipPromise = fetch("https://api.ipify.org?format=json", {
    cache: "no-store",
  })
    .then((r) => r.json())
    .then((j: { ip?: string }) => j.ip ?? null)
    .catch(() => null);

  // Reproduce the EXACT fetch the production extractor makes —
  // user-agent, headers, redirect mode all identical so the result is a
  // faithful diagnostic of what the extractor would see.
  let pinterest: Record<string, unknown> = {};
  try {
    const res = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const body = await res.text();

    // Subset of response headers most useful for diagnosing blocks /
    // CDN behaviour. CF / Cloudflare-Worker / x-served-by tell us if a
    // bot-protection layer is intercepting.
    const headers: Record<string, string> = {};
    for (const k of [
      "content-type",
      "content-length",
      "server",
      "cf-ray",
      "cf-cache-status",
      "x-served-by",
      "x-cache",
      "x-amz-cf-pop",
      "x-content-type-options",
      "x-cf-bot-management-action",
      "set-cookie",
    ]) {
      const v = res.headers.get(k);
      if (v) headers[k] = v;
    }

    // Image-URL count in the static HTML. The extractor needs at least
    // one i.pinimg.com URL to find a pin image, so 0 here means the
    // server got back a CAPTCHA / login wall and the extractor would
    // throw "Couldn't pull any images…" downstream.
    const imgMatches = body.match(/i\.pinimg\.com\//gi);
    const imageUrlCount = imgMatches?.length ?? 0;

    // Heuristics for common block / wall pages. Pinterest's login wall
    // and Cloudflare's anti-bot challenge both look like "200 OK" to
    // fetch but contain no scrapeable content.
    const lower = body.toLowerCase();
    const hasLoginMarker =
      /\b(log in to|sign up to|create an account)\b/.test(lower) &&
      imageUrlCount < 5;
    const hasCaptchaMarker =
      /captcha|cf-challenge|cloudflare ray|attention required/.test(lower);

    pinterest = {
      status: res.status,
      statusText: res.statusText,
      finalUrl: res.url,
      redirected: res.redirected,
      headers,
      bodyBytes: body.length,
      imageUrlCount,
      hasLoginMarker,
      hasCaptchaMarker,
      // First 500 chars of body — enough to see <html> / <title> / any
      // CAPTCHA marker without dumping the whole 900KB response.
      bodyPreview: body.slice(0, 500),
    };
  } catch (e) {
    pinterest = {
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }

  const outboundIp = await ipPromise;

  return NextResponse.json({
    outboundIp,
    pinterest,
    ms: Date.now() - t0,
    note: outboundIp
      ? "outboundIp is what Pinterest sees as the client. Vercel data-center IPs are commonly blocked / served a login wall by Pinterest."
      : undefined,
  });
}

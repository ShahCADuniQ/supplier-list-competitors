// Find where Pinterest stores a pin's outbound link (the "Visit site" target).
const URL = "https://ca.pinterest.com/pin/4605282531605954816/";
const res = await fetch(URL, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  },
});
const html = await res.text();
console.log(`html: ${html.length}B`);

// 1. og:see_also (rich pin source link)
const m1 = html.match(/<meta\s+property=["']og:see_also["']\s+content=["']([^"']+)["']/i);
console.log("og:see_also:", m1 ? m1[1] : "absent");

// 2. og:url
const m2 = html.match(/<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i);
console.log("og:url:", m2 ? m2[1] : "absent");

// 3. <link rel="canonical">
const m3 = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
console.log("link rel=canonical:", m3 ? m3[1] : "absent");

// 4. Look for "link" / "rich_pin" / "domain" fields in JSON-LD or __PWS_*
console.log("\n--- searching for pin link in JSON ---");
for (const re of [
  /"link"\s*:\s*"(https?:\/\/[^"]+)"/gi,
  /"rich_pin_application_summary"[\s\S]{0,200}/gi,
  /"domain"\s*:\s*"([^"]+)"/gi,
  /"site_name"\s*:\s*"([^"]+)"/gi,
  /"display_name"\s*:\s*"([^"]+)"/gi,
]) {
  const found = [...html.matchAll(re)];
  console.log(`${re.source.slice(0, 50)}: ${found.length} matches`);
  for (const m of found.slice(0, 5)) {
    const v = m[1] ?? m[0];
    console.log(`  ${v.slice(0, 200)}`);
  }
}

// 5. Look for application/ld+json structured data
const ldJsonMatches = [...html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
console.log(`\nld+json scripts: ${ldJsonMatches.length}`);
for (const m of ldJsonMatches.slice(0, 3)) {
  console.log("---");
  console.log(m[1].slice(0, 1500));
}

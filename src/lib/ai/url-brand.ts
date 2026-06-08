// Derive a human-readable brand / supplier name from a product URL.
// Used by the "Add purchase source" dialog so the user doesn't have to retype
// the obvious — when they paste an amazon.ca URL we suggest "Amazon", a
// digikey URL becomes "DigiKey", and a no-name brand domain becomes its
// capitalised first segment ("makerele.com" → "Makerele").

const KNOWN_BRANDS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /^(www\.)?amazon\./i, name: "Amazon" },
  { pattern: /^(www\.)?ebay\./i, name: "eBay" },
  { pattern: /^(www\.)?aliexpress\./i, name: "AliExpress" },
  { pattern: /^(www\.)?alibaba\./i, name: "Alibaba" },
  { pattern: /^(www\.)?temu\./i, name: "Temu" },
  { pattern: /^(www\.)?etsy\./i, name: "Etsy" },
  { pattern: /^(www\.)?walmart\./i, name: "Walmart" },
  { pattern: /^(www\.)?target\./i, name: "Target" },
  { pattern: /^(www\.)?costco\./i, name: "Costco" },
  { pattern: /^(www\.)?bestbuy\./i, name: "Best Buy" },
  { pattern: /^(www\.)?homedepot\./i, name: "Home Depot" },
  { pattern: /^(www\.)?lowes\./i, name: "Lowe's" },
  { pattern: /^(www\.)?canadiantire\./i, name: "Canadian Tire" },
  { pattern: /^(www\.)?rona\./i, name: "Rona" },
  { pattern: /^(www\.)?digikey\./i, name: "DigiKey" },
  { pattern: /^(www\.)?mouser\./i, name: "Mouser" },
  { pattern: /^(www\.)?newark\./i, name: "Newark" },
  { pattern: /^(www\.)?arrow\./i, name: "Arrow Electronics" },
  { pattern: /^(www\.)?rs-online\./i, name: "RS Components" },
  { pattern: /^(www\.)?farnell\./i, name: "Farnell" },
  { pattern: /^(www\.)?mcmaster\./i, name: "McMaster-Carr" },
  { pattern: /^(www\.)?grainger\./i, name: "Grainger" },
  { pattern: /^(www\.)?uline\./i, name: "Uline" },
  { pattern: /^(www\.)?fastenal\./i, name: "Fastenal" },
  { pattern: /^(www\.)?msc(direct)?\./i, name: "MSC Industrial" },
  { pattern: /^(www\.)?made-in-china\./i, name: "Made-in-China" },
  { pattern: /^(www\.)?globalsources\./i, name: "Global Sources" },
];

export function deriveBrandFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let host: string;
  try {
    const u = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const { pattern, name } of KNOWN_BRANDS) {
    if (pattern.test(host)) return name;
  }
  // Fallback: take the first segment of the bare domain, split on dashes and
  // underscores, title-case each chunk. Skip the leading "www." if present.
  const bare = host.replace(/^www\./, "");
  const root = bare.split(".")[0];
  if (!root) return null;
  return root
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Domain-only version (e.g. "amazon.ca", "makerele.com") — handy for the
// supplier website field when we autocreate a supplier from a URL.
export function deriveWebsiteFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`,
    );
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return null;
  }
}

// Shopify storefront fast-path for the supplier add-product extractor.
// Every Shopify store exposes /products/<handle>.json by default — it
// returns the full product record including title, vendor, description,
// every image, and every variant. That's strictly better data than what
// Perplexity + Claude can reconstruct from page text. When this works we
// skip the AI pipeline entirely; when it fails (404, store disabled the
// endpoint, non-Shopify site) we fall back to AI extraction.

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type ShopifyImage = {
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
};

export type ShopifyVariant = {
  id: number;
  title: string;
  sku: string | null;
  price: string | null;
  available: boolean | null;
  // Combined option label, e.g. "Black / 8mm / 100 pcs".
  options: string[];
};

export type ShopifyProduct = {
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  description: string;
  storefrontUrl: string;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
};

// Strips HTML tags from Shopify's body_html (a sanitised plain-text version
// of the description). Not perfect — leaves entities un-decoded — but good
// enough for an ERP catalogue description field where we render plain text.
function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|li|h\d|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseShopifyHandleFromUrl(pageUrl: string): {
  origin: string;
  handle: string;
} | null {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/\/products\/([^\/?#]+)/i);
    if (!m) return null;
    return { origin: `${u.protocol}//${u.host}`, handle: m[1] };
  } catch {
    return null;
  }
}

// Returns the Shopify product record for a /products/<handle>[?variant=...]
// URL, or null if the JSON endpoint isn't available (non-Shopify store,
// product hidden, store disabled the endpoint, network error, etc.).
export async function tryFetchShopifyProduct(
  pageUrl: string,
): Promise<ShopifyProduct | null> {
  const parsed = parseShopifyHandleFromUrl(pageUrl);
  if (!parsed) return null;
  const { origin, handle } = parsed;
  const jsonUrl = `${origin}/products/${handle}.json`;

  let res: Response;
  try {
    res = await fetch(jsonUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json,text/plain,*/*",
        Referer: `${origin}/`,
      },
      redirect: "follow",
    });
  } catch (err) {
    console.warn(`[shopify] network error fetching ${jsonUrl}`, err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[shopify] HTTP ${res.status} for ${jsonUrl}`);
    return null;
  }
  // Some non-Shopify stores return HTML at .json paths. Sniff the body.
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  // Expected shape: { product: { ... } }
  const product = (json as { product?: Record<string, unknown> } | undefined)
    ?.product;
  if (!product || typeof product !== "object") return null;

  const title = (product.title as string) || "";
  if (!title) return null;

  const vendor = (product.vendor as string) || null;
  const productType = (product.product_type as string) || null;
  const description = stripHtml((product.body_html as string) || "");

  const rawImages = (product.images as Array<Record<string, unknown>>) ?? [];
  const images: ShopifyImage[] = rawImages
    .map((img) => ({
      src: (img.src as string) || "",
      alt: (img.alt as string) || null,
      width: (img.width as number) ?? null,
      height: (img.height as number) ?? null,
    }))
    .filter((img) => /^https?:\/\//i.test(img.src));

  const rawVariants =
    (product.variants as Array<Record<string, unknown>>) ?? [];
  const variants: ShopifyVariant[] = rawVariants.map((v) => {
    // option1, option2, option3 carry each option's value.
    const options: string[] = [];
    for (const k of ["option1", "option2", "option3"]) {
      const val = v[k];
      if (typeof val === "string" && val.trim()) options.push(val.trim());
    }
    return {
      id: typeof v.id === "number" ? v.id : Number(v.id) || 0,
      title: (v.title as string) || options.join(" / ") || "Default",
      sku: (v.sku as string) || null,
      price: (v.price as string) || null,
      available: typeof v.available === "boolean" ? v.available : null,
      options,
    };
  });

  return {
    handle,
    title,
    vendor,
    productType,
    description,
    storefrontUrl: origin,
    images,
    variants,
  };
}

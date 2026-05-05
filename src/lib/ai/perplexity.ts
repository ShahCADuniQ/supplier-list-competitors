// Perplexity Sonar client. We use Perplexity for live web research because its
// `sonar-pro` model has built-in indexing across the public web — significantly
// more thorough than crawling a homepage and reasoning over what's there.
//
// API is OpenAI-compatible (POST /chat/completions, bearer auth) but the
// response has an extra `citations` array we surface so callers can show
// sources.

const PPLX_BASE = "https://api.perplexity.ai";

/** Default model — `sonar-pro` is fast + thorough.
 *  `sonar-deep-research` is more exhaustive but slow (60-120s per call). */
export const PPLX_MODEL = process.env.PERPLEXITY_MODEL || process.env.PPLX_MODEL || "sonar-pro";

function getApiKey(): string {
  const key =
    process.env.PPLX_API_KEY ||
    process.env.PERPLEXITY_API_KEY;
  if (!key) {
    throw new Error(
      "PPLX_API_KEY (or PERPLEXITY_API_KEY) not set — add it to .env to enable Perplexity-backed search.",
    );
  }
  return key;
}

export function hasPerplexityKey(): boolean {
  return !!(process.env.PPLX_API_KEY || process.env.PERPLEXITY_API_KEY);
}

export type PplxOptions = {
  systemPrompt: string;
  userPrompt: string;
  /** When provided, asks Perplexity for structured JSON output. */
  schema?: Record<string, unknown>;
  schemaName?: string;
  model?: string;
  /** Restrict search to specific domains (e.g. ["lumenpulse.com"]). */
  searchDomains?: string[];
  /** Optional max tokens cap for the model. */
  maxTokens?: number;
};

export type PplxResult<T = string> = {
  /** Parsed JSON when `schema` was provided, otherwise the raw text. */
  content: T;
  /** Source URLs Perplexity used. */
  citations: string[];
  /** Raw search results entries Perplexity included with the response. */
  searchResults?: Array<{ title?: string; url?: string }>;
};

/**
 * Generic wrapper around Perplexity's chat completions endpoint.
 *
 * Schema usage:
 *   const r = await perplexityChat<{products: ...}>({
 *     systemPrompt, userPrompt,
 *     schema: PRODUCT_LIST_SCHEMA,
 *     schemaName: "product_list",
 *   });
 *   r.content.products.forEach(...);
 */
export async function perplexityChat<T = string>(
  opts: PplxOptions,
): Promise<PplxResult<T>> {
  const apiKey = getApiKey();
  const body: Record<string, unknown> = {
    model: opts.model || PPLX_MODEL,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    // Lower temp → more deterministic JSON / list output. The user can adjust
    // via system prompt if creativity is wanted somewhere.
    temperature: 0.1,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        schema: opts.schema,
      },
    };
  }
  if (opts.searchDomains?.length) {
    // Perplexity supports `search_domain_filter` to bias to specific domains.
    body.search_domain_filter = opts.searchDomains.slice(0, 10);
  }

  const res = await fetch(`${PPLX_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Perplexity ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
    search_results?: Array<{ url?: string; title?: string }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  const citations =
    data.citations ??
    data.search_results?.map((s) => s.url).filter((u): u is string => !!u) ??
    [];
  const searchResults = data.search_results ?? [];

  if (!opts.schema) {
    return { content: raw as unknown as T, citations, searchResults };
  }
  // Perplexity sometimes returns valid JSON, sometimes wraps in fences. Be
  // forgiving.
  try {
    return { content: JSON.parse(raw) as T, citations, searchResults };
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return { content: JSON.parse(m[0]) as T, citations, searchResults };
      } catch {
        // fall through
      }
    }
    throw new Error(
      `Perplexity returned non-JSON despite schema: ${raw.slice(0, 300)}`,
    );
  }
}

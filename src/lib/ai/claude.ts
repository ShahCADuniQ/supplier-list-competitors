// Anthropic / Claude client. Lazy singleton — keeps a handle to one shared
// client and won't crash at import time if ANTHROPIC_API_KEY is missing.
//
// We use Claude (not GPT-4o-mini) for spec extraction from PDFs because:
//   1. Claude accepts PDF documents NATIVELY as content blocks — no text-
//      extraction layer between us and the source. That preserves tables and
//      dimensional figures (the format spec sheets use) much better than the
//      pdf-parse text-only output we used previously.
//   2. Claude's tool-use mode gives strict JSON output that matches our
//      product schema precisely.

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function claudeClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env to enable PDF spec analysis with Claude.",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export function hasClaudeKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Default model — Sonnet 4.5. Reads architectural-lighting spec tables and
 * dimensional drawings well at ~1/5 the per-token cost of Opus 4.7. Override
 * via ANTHROPIC_MODEL when a particular collection benefits from Opus's
 * extra rigor on dense / multi-variant catalogs.
 *
 * If the API key's tier doesn't include the primary model, the analyzer
 * automatically retries with one of the fallbacks below — so a 404 / 403
 * "model not available" doesn't surface as an error to the user.
 */
export const CLAUDE_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

/**
 * Fallback chain when the primary model returns a "model not found" /
 * "permission" / "invalid model" error. Ordered cheapest-acceptable →
 * cheapest-safe so a downgrade still gets work done (Haiku 4.5 is the
 * safety net — fast and cheap, less thorough on dense spec tables but
 * better than failing).
 */
export const CLAUDE_FALLBACK_MODELS = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

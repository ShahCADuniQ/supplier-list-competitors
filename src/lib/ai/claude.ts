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
 * Default model — Opus 4.7, Anthropic's strongest at reading densely-laid-out
 * spec tables and dimensional drawings. Override via ANTHROPIC_MODEL.
 *
 * If the API key's tier doesn't include the primary model, the analyzer
 * automatically retries with one of the fallbacks below — so a 404 / 403
 * "model not available" doesn't surface as an error to the user.
 */
export const CLAUDE_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-opus-4-7";

/**
 * Fallback chain when the primary model returns a "model not found" or
 * "permission" error. Ordered by capability — Opus 4.6 is closest in spec-
 * reading ability, Sonnet 4.5 is broadly available, Haiku is the safety net.
 */
export const CLAUDE_FALLBACK_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

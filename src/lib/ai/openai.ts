import OpenAI from "openai";

let _client: OpenAI | null = null;

/**
 * Lazy singleton so we don't crash at import time when the key is missing
 * (e.g. during the build step before env vars are wired up).
 */
export function openaiClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env to enable AI features.",
    );
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

/**
 * gpt-4o-mini is cheap, fast, and supports structured outputs + vision.
 * Override for special cases via env: OPENAI_MODEL.
 */
export const AI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

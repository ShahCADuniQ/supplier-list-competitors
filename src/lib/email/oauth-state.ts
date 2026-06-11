// Tiny HMAC-signed state cookie helper for the OAuth start → callback
// flow. We bake the Clerk user id + provider into the state and verify
// the signature on callback, so a victim's authorisation code can never
// be redeemed against an attacker's account (classic OAuth CSRF).
//
// Keyed off EMAIL_TOKEN_ENCRYPTION_KEY — same secret as token-at-rest
// encryption; no extra env var to set.

import { createHmac, randomBytes } from "node:crypto";
import type { EmailProvider } from "./types";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const COOKIE_NAME = "email_oauth_state";

function key(): string {
  const raw = process.env.EMAIL_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "EMAIL_TOKEN_ENCRYPTION_KEY must be set to use email OAuth.",
    );
  }
  return raw;
}

export type StatePayload = {
  u: string; // clerk user id
  p: EmailProvider;
  n: string; // nonce
  t: number; // issued-at ms
};

export function signState(payload: Omit<StatePayload, "n" | "t">): string {
  const full: StatePayload = {
    ...payload,
    n: randomBytes(12).toString("hex"),
    t: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  const sig = createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(token: string): StatePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", key()).update(body).digest("base64url");
  // Constant-time compare via length-then-bitwise
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) return null;
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.t !== "number") return null;
  if (Date.now() - payload.t > STATE_TTL_MS) return null;
  return payload;
}

export { COOKIE_NAME as STATE_COOKIE };

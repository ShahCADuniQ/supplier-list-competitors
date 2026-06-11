// AES-256-GCM helpers for OAuth token storage. Tokens live in
// user_email_connections.access_token_encrypted /
// refresh_token_encrypted as a single base64 blob structured as
//   [12-byte IV][16-byte auth tag][ciphertext]
// so encrypt + decrypt can carry everything in one column.
//
// Key source: EMAIL_TOKEN_ENCRYPTION_KEY env var. The value can be any
// length; we hash it to 32 bytes with SHA-256 to fit AES-256. Setting
// a value is REQUIRED — without it the helpers throw at first call
// rather than silently storing plaintext.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let _cachedKey: Buffer | null = null;
function key(): Buffer {
  if (_cachedKey) return _cachedKey;
  const raw = process.env.EMAIL_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "EMAIL_TOKEN_ENCRYPTION_KEY is not set. Add a long random value to .env so OAuth tokens can be encrypted at rest.",
    );
  }
  if (raw.length < 16) {
    throw new Error(
      "EMAIL_TOKEN_ENCRYPTION_KEY must be at least 16 characters. Use a long random value.",
    );
  }
  _cachedKey = createHash("sha256").update(raw, "utf8").digest();
  return _cachedKey;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptToken(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error("Encrypted token is too short to be valid");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

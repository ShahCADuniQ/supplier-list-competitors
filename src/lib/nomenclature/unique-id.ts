// 6-character A-Z + 0-9 alphanumeric ID allocator. 36^6 = ~2.18B
// values — comfortably larger than any internal parts catalogue. We
// DO reuse IDs after deletion (the user asked for this) so collisions
// matter, but with billions of slots and at most a few thousand active
// IDs the expected number of tries is essentially 1.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { nomenclatureParts } from "@/db/schema";

export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // 36 chars
export const LENGTH = 6;
export const ID_SPACE = ALPHABET.length ** LENGTH; // 2,176,782,336
const MAX_TRIES = 200;

export function randomUniqueId(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export async function allocateUniqueId(): Promise<string> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = randomUniqueId();
    const existing = await db
      .select({ id: nomenclatureParts.id })
      .from(nomenclatureParts)
      .where(eq(nomenclatureParts.uniqueId, candidate))
      .limit(1);
    if (!existing.length) return candidate;
  }
  throw new Error(
    "Could not allocate a fresh nomenclature ID after 200 tries — alphabet is exhausted, widen the length.",
  );
}

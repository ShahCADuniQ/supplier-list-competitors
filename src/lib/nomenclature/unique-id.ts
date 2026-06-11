// 4-character A-Z + 0-9 alphanumeric ID allocator. 36^4 = ~1.68M
// values, plenty for an internal parts catalogue. We DO reuse IDs
// after deletion (the user asked for this) so collisions matter — we
// allocate by sampling random IDs and checking the DB until we land
// on a free one. With 1.68M slots and a few thousand active IDs the
// expected number of tries is essentially 1.
//
// I-O-0-1 are dropped from the alphabet to avoid the standard "I vs 1,
// O vs 0" stencil confusion on shop floor labels.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { nomenclatureParts } from "@/db/schema";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars
const LENGTH = 4;
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

// One-off: flip the test-supplier account to onboarding_status='pending'
// so the user can verify the new gate from the portal.
// Targets the supplier row matched by hasaanshah19n@gmail.com (either as
// the suppliers.email or via a supplier_contacts.email link).
//
// Run with: npx tsx --env-file=.env scripts/set-test-supplier-pending.ts

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = neon(url);

const TEST_EMAIL = "hasaanshah19n@gmail.com";

async function main() {
  const direct = await sql.query(
    `SELECT id, name, email, onboarding_status FROM suppliers WHERE LOWER(email) = $1`,
    [TEST_EMAIL.toLowerCase()],
  );
  const viaContact = await sql.query(
    `SELECT s.id, s.name, s.email, s.onboarding_status
     FROM suppliers s
     JOIN supplier_contacts c ON c.supplier_id = s.id
     WHERE LOWER(c.email) = $1`,
    [TEST_EMAIL.toLowerCase()],
  );
  const matches = [...direct, ...viaContact];
  if (matches.length === 0) {
    console.log(`No supplier rows matched ${TEST_EMAIL}. Nothing to update.`);
    return;
  }
  for (const row of matches) {
    const r = row as { id: number; name: string; onboarding_status: string };
    console.log(`Flipping #${r.id} "${r.name}" (was ${r.onboarding_status}) → pending`);
    await sql.query(
      `UPDATE suppliers
         SET onboarding_status = 'pending',
             onboarding_submitted_at = NULL,
             onboarding_reviewed_at = NULL,
             onboarding_reviewed_by_clerk_id = NULL,
             onboarding_reviewer_notes = NULL,
             updated_at = now()
       WHERE id = $1`,
      [r.id],
    );
  }
  console.log(`\nDone. ${matches.length} supplier row(s) flipped to pending.`);
}
main().catch((e) => { console.error(e); process.exit(1); });

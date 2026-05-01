import { db } from "../src/db";
import {
  suppliers,
  supplierProjectEntries,
  supplierComments,
  competitorCollections,
  competitors,
} from "../src/db/schema";
import { asc } from "drizzle-orm";

async function main() {
  const sup = await db.select({ id: suppliers.id, name: suppliers.name, category: suppliers.category, origin: suppliers.origin, status: suppliers.status }).from(suppliers).orderBy(asc(suppliers.name));
  const peCount = (await db.select().from(supplierProjectEntries)).length;
  const comCount = (await db.select().from(supplierComments)).length;
  const colls = await db.select().from(competitorCollections);
  const comps = await db.select({ id: competitors.id }).from(competitors);

  console.log(`Suppliers (${sup.length}):`);
  sup.forEach((s, i) => console.log(`  ${(i + 1).toString().padStart(2, " ")}. ${s.name.padEnd(28, " ")} ${s.category ?? ""} · ${s.origin ?? ""} · ${s.status}`));
  console.log(`\nProject entries: ${peCount}`);
  console.log(`Comments: ${comCount}`);
  console.log(`\nCollections (${colls.length}):`);
  colls.forEach((c) => console.log(`  - ${c.name}`));
  console.log(`Competitors total: ${comps.length}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

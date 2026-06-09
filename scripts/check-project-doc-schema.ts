import { db } from "../src/db";
import { sql } from "drizzle-orm";

async function main() {
  const cols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name='supplier_product_attachments'
       AND column_name IN ('project_num','project_doc_type')
     ORDER BY column_name
  `);
  console.log("columns:", JSON.stringify(cols, null, 2));

  const docTypes = await db.execute(sql`
    SELECT enumlabel FROM pg_enum
     WHERE enumtypid='supplier_product_project_doc_type'::regtype
     ORDER BY enumsortorder
  `);
  console.log("doc types:", JSON.stringify(docTypes, null, 2));

  const cats = await db.execute(sql`
    SELECT enumlabel FROM pg_enum
     WHERE enumtypid='supplier_product_attachment_category'::regtype
     ORDER BY enumsortorder
  `);
  console.log("category enum values:", JSON.stringify(cats, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

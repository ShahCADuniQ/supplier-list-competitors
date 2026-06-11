// Design & Engineering landing — now the Nomenclature Generator.
// Projects moved to /design-engineering/projects so the sub-nav can
// show Nomenclature first while keeping every existing project URL
// (/design-engineering/projects/[id]) working.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DesignEngineeringIndex() {
  // Single-file redirect so we keep the routing simple: hitting
  // /design-engineering lands the user on the Nomenclature tab.
  redirect("/design-engineering/nomenclature");
}

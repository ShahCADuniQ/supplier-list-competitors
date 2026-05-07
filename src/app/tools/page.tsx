import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function ToolsLanding() {
  redirect("/tools/municipal-contacts");
}

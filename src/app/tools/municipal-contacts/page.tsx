import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Municipal Contacts (lead generator) moved under CRM. Keep this redirect so
// existing bookmarks and emailed links still land on the right page.
export default function MovedMunicipalContactsRedirect() {
  redirect("/crm/municipal-contacts");
}

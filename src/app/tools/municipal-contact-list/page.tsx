import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Municipal Contact List moved under CRM. Keep this redirect so existing
// bookmarks and emailed links still land on the right page.
export default function MovedMunicipalContactListRedirect() {
  redirect("/crm/municipal-contact-list");
}

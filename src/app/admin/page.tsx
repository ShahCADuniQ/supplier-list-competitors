import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { userProfiles } from "@/db/schema";
import {
  getOrCreateProfile,
  isAdmin,
  ADMIN_EMAILS,
  ADMIN_EMAIL_DOMAINS,
} from "@/lib/permissions";
import AdminPanel from "./AdminPanel";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const profile = await getOrCreateProfile();
  if (!profile) redirect("/sign-in");
  if (!isAdmin(profile)) redirect("/");

  const users = await db
    .select()
    .from(userProfiles)
    .orderBy(asc(userProfiles.createdAt));

  return (
    <AdminPanel
      users={users}
      adminEmails={[...ADMIN_EMAILS]}
      adminDomains={[...ADMIN_EMAIL_DOMAINS]}
      currentClerkId={profile.clerkUserId}
    />
  );
}

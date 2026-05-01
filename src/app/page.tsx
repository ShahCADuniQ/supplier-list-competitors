import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canViewCompetitors,
  isAdmin,
} from "@/lib/permissions";

export default async function Home() {
  const profile = await getOrCreateProfile();

  if (!profile) {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold mb-3">Lightbase</h1>
          <p className="text-zinc-600 dark:text-zinc-400 mb-6">
            Sign in or sign up to continue. New accounts require admin approval before
            you can view suppliers or competitors.
          </p>
        </div>
      </div>
    );
  }

  const sup = canViewSuppliers(profile);
  const comp = canViewCompetitors(profile);

  if (sup && !comp) redirect("/suppliers");
  if (!sup && comp) redirect("/competitors");
  if (sup && comp) redirect("/suppliers");

  if (isAdmin(profile)) redirect("/admin");

  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="max-w-lg text-center bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-10 shadow-sm">
        <div className="inline-flex w-12 h-12 items-center justify-center rounded-xl bg-amber-50 text-amber-700 mb-4 text-xl">
          ⏳
        </div>
        <h1 className="text-2xl font-semibold mb-2">Awaiting access</h1>
        <p className="text-zinc-600 dark:text-zinc-400 mb-6">
          Your account is signed in but doesn&apos;t have access to anything yet.
          An administrator (<span className="font-medium">hshah@lightbase.ca</span>)
          needs to grant you access to the supplier list, competitor tracker, or
          both.
        </p>
        <p className="text-sm text-zinc-500">
          Once approved this page will redirect automatically. You can{" "}
          <Link href="/" className="underline">refresh</Link> at any time.
        </p>
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import {
  ClerkProvider,
  SignInButton,
  SignUpButton,
  Show,
  UserButton,
} from "@clerk/nextjs";
import TopNav from "@/components/TopNav";
import {
  getOrCreateProfile,
  isAdmin,
  canViewSuppliers,
  canViewCompetitors,
} from "@/lib/permissions";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lightbase — Supplier & Competitor Manager",
  description:
    "Internal tool for tracking supplier performance and competitor intelligence.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const profile = await getOrCreateProfile();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-black">
        <ClerkProvider>
          <header className="flex justify-between items-center gap-4 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
            <div className="flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
                <span className="inline-block w-5 h-5 rounded-md bg-gradient-to-br from-amber-300 to-amber-700" />
                Lightbase
              </Link>
              {profile && (
                <TopNav
                  canViewSuppliers={canViewSuppliers(profile)}
                  canViewCompetitors={canViewCompetitors(profile)}
                  isAdmin={isAdmin(profile)}
                />
              )}
            </div>
            <div className="flex items-center gap-3">
              <Show when="signed-out">
                <SignInButton />
                <SignUpButton />
              </Show>
              <Show when="signed-in">
                {profile && (
                  <span className="hidden sm:inline text-xs text-zinc-500">
                    {profile.email}
                    {profile.role !== "member" && (
                      <span className="ml-2 px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 uppercase tracking-wider">
                        {profile.role}
                      </span>
                    )}
                  </span>
                )}
                <UserButton />
              </Show>
            </div>
          </header>
          <main className="flex-1 flex flex-col min-h-0">{children}</main>
        </ClerkProvider>
      </body>
    </html>
  );
}

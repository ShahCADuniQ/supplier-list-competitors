import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import AppShell from "@/components/AppShell";
import { NO_FOUC_SCRIPT } from "@/lib/theme";
import {
  getOrCreateProfile,
  isAdmin,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
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
  title: "Lightbase — Operations",
  description:
    "Internal operations console: suppliers, inventory, manufacturing, and competitor intelligence.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const profile = await getOrCreateProfile();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          // No-FOUC: applies the persisted theme before first paint.
          dangerouslySetInnerHTML={{ __html: NO_FOUC_SCRIPT }}
        />
      </head>
      <body
        className="min-h-full"
        style={{ background: "var(--lb-bg)", color: "var(--lb-text)" }}
      >
        <ClerkProvider>
          {profile ? (
            <AppShell
              email={profile.email}
              role={profile.role}
              canViewSuppliers={canViewSuppliers(profile)}
              canViewCompetitors={canViewCompetitors(profile)}
              canViewHandbook={canViewHandbook(profile)}
              canViewEngineering={canViewEngineering(profile)}
              isAdmin={isAdmin(profile)}
            >
              {children}
            </AppShell>
          ) : (
            // Signed-out users: no shell, just the page (sign-in / landing).
            <div
              className="min-h-screen w-full flex flex-col"
              style={{ background: "var(--lb-bg)" }}
            >
              {children}
            </div>
          )}
        </ClerkProvider>
      </body>
    </html>
  );
}

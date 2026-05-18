import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import AppShell from "@/components/AppShell";
import { NO_FOUC_SCRIPT } from "@/lib/theme";
import {
  getOrCreateProfile,
  isAdmin,
  isSupplierUser,
  canViewSuppliers,
  canViewCompetitors,
  canViewHandbook,
  canViewEngineering,
  canViewDesignEngineering,
  canViewCrm,
  canViewOee,
} from "@/lib/permissions";
import { CLIENT_CONFIG, CADUNIQ_PRODUCT_LABEL } from "@/lib/client-config";
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
  title: `${CLIENT_CONFIG.name} — Operations · a ${CADUNIQ_PRODUCT_LABEL} product`,
  description: `Internal operations console for ${CLIENT_CONFIG.name}: suppliers, inventory, ${CLIENT_CONFIG.industry}, and competitor intelligence. Property & software of ${CADUNIQ_PRODUCT_LABEL}.`,
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
              isSupplier={isSupplierUser(profile)}
              canViewSuppliers={canViewSuppliers(profile)}
              canViewCompetitors={canViewCompetitors(profile)}
              canViewHandbook={canViewHandbook(profile)}
              canViewEngineering={canViewEngineering(profile)}
              canViewDesignEngineering={canViewDesignEngineering(profile)}
              canViewCrm={canViewCrm(profile)}
              canViewOee={canViewOee(profile)}
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

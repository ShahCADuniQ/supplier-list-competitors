// Token-gated upload endpoint for the public /vendor/[token] portal.
// Supplier uploads (datasheets, certifications, brochures, the original
// quote PDF) go through this route instead of /api/blob/upload because the
// supplier doesn't have a Clerk session. The vendor portal's `upload()`
// call forwards the magic-link token via `clientPayload`; this handler
// verifies it against rfq_recipients before issuing a signed Vercel Blob
// upload URL.

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rfqRecipients } from "@/db/schema";
import { ensureOrdersSchema } from "@/app/suppliers/_ensure-orders-schema";

const ALLOWED = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-excel",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/zip",
  "text/plain",
  "text/csv",
];
const MAX_BYTES = 50 * 1024 * 1024;

export async function POST(request: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Blob storage not configured: set BLOB_READ_WRITE_TOKEN" },
      { status: 500 },
    );
  }

  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const token = (clientPayload ?? "").trim();
        if (!token) throw new Error("Missing access token");
        await ensureOrdersSchema();
        const [recipient] = await db
          .select()
          .from(rfqRecipients)
          .where(eq(rfqRecipients.accessToken, token))
          .limit(1);
        if (!recipient) throw new Error("Invalid token");
        if (recipient.tokenExpiresAt && recipient.tokenExpiresAt < new Date()) {
          throw new Error("Token expired");
        }
        if (!/^vendor-quotes\//.test(pathname)) {
          throw new Error("Invalid upload path");
        }
        return {
          allowedContentTypes: ALLOWED,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ recipientId: recipient.id }),
        };
      },
      onUploadCompleted: async () => {
        // Metadata is recorded by the explicit server action
        // (addVendorQuoteAttachment) — nothing to do here.
      },
    });
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 400 },
    );
  }
}

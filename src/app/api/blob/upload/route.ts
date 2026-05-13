import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse, type NextRequest } from "next/server";
import { getOrCreateProfile, canEdit } from "@/lib/permissions";

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

// CAD files from the browser typically arrive as application/octet-stream
// (no registered MIME for STEP / IGES / native SLDPRT / IPT / F3D / etc.).
// We additively allow this MIME for the design-engineering upload scope and
// for that scope only — keeps the upload pipe wide enough to receive any
// engineering file while leaving the supplier / competitor scopes locked
// to the safer ALLOWED whitelist.
const ALLOWED_DESIGN_ENG = [
  ...ALLOWED,
  "application/octet-stream",
  "model/step+xml",
  "model/stl",
  "model/gltf-binary",
  "model/gltf+json",
  "model/3mf",
  "model/obj",
  "application/sla",
  "application/iges",
  "application/step",
  "application/vnd.ms-pki.stl",
];

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB — CAD files can be large

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
      onBeforeGenerateToken: async (pathname) => {
        const profile = await getOrCreateProfile();
        if (!profile || !canEdit(profile)) {
          throw new Error("Unauthorized");
        }
        // Lock down which paths are allowed so a hostile client can't write
        // outside the expected scopes. `ai-temp/` is for files uploaded by the
        // AI-generation flow before a supplier/competitor exists; they're
        // reattached under the proper scope on save.
        if (!/^(suppliers|competitors|ai-temp|design-engineering)\//.test(pathname)) {
          throw new Error("Invalid upload path");
        }
        const isDesignEng = /^design-engineering\//.test(pathname);
        return {
          allowedContentTypes: isDesignEng ? ALLOWED_DESIGN_ENG : ALLOWED,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ clerkUserId: profile.clerkUserId }),
        };
      },
      onUploadCompleted: async () => {
        // We rely on the explicit "save attachment" server action the client
        // calls right after upload to record metadata in Postgres, so nothing
        // to do here. Keep this handler defined or @vercel/blob will throw.
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

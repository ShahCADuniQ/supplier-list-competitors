import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse, type NextRequest } from "next/server";
import { getOrCreateProfile, canEdit, isSupplierUser } from "@/lib/permissions";

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

// Wider image-type list used by the supplier scope so phones can upload
// HEIC / HEIF straight from the camera roll, designers can drop SVG /
// TIFF, etc. Also includes octet-stream so files the browser can't MIME-
// detect (drag-drop from some apps, or older iOS exports) still go
// through. Document types from ALLOWED stay valid here too.
const ALLOWED_SUPPLIER = [
  ...ALLOWED,
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/svg+xml",
  "image/bmp",
  "image/avif",
  // IES photometric files don't have a registered MIME — phones / browsers
  // send them as text/plain or octet-stream. Both fall through here.
  "application/octet-stream",
];

// CAD scope for the supplier "Drawings" category — accepts everything an
// engineer could conceivably drop in: STEP, IGES, Parasolid, SolidWorks,
// Inventor, Catia, Fusion 360, Rhino, AutoCAD (DWG/DXF), 3D mesh formats
// (STL/OBJ/glTF/3MF), IFC, plus the document/image fallbacks for
// drawings exported as PDF or rendered images.
//
// In practice browsers send most of these as application/octet-stream
// (no registered MIME for native CAD files), so the octet-stream allow
// in ALLOWED_SUPPLIER already gets them through — the explicit entries
// below are belt-and-braces for the few formats that DO carry a MIME.
const ALLOWED_SUPPLIER_CAD = [
  ...ALLOWED_SUPPLIER,
  // Neutral exchange formats
  "model/step+xml", "model/step", "application/step", "application/x-step",
  "application/iges", "model/iges",
  "model/stl", "application/sla", "application/vnd.ms-pki.stl",
  // 3D mesh / web-friendly formats
  "model/gltf-binary", "model/gltf+json", "model/3mf", "model/obj",
  "application/x-fbx", "model/vnd.collada+xml", "model/x-ply",
  // AutoCAD
  "application/acad", "application/x-acad", "application/x-autocad",
  "image/vnd.dwg", "image/vnd.dxf",
  "application/dxf", "application/dwg",
  // Industry / BIM
  "application/ifc", "model/ifc",
  // Catch-all so the route never blocks a legitimate vendor CAD format
  // we forgot to enumerate.
  "application/octet-stream",
];

// CAD files from the browser typically arrive as application/octet-stream
// (no registered MIME for STEP / IGES / native SLDPRT / IPT / F3D / etc.).
// We additively allow this MIME for the design-engineering upload scope and
// for that scope only — keeps the upload pipe wide enough to receive any
// engineering file while leaving the supplier / competitor scopes locked
// to the safer ALLOWED whitelist.
const ALLOWED_CAD = [
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
  // IFC files. Some browsers send the empty string or octet-stream because
  // there's no registered MIME — but Revit / ArchiCAD / etc. exports also
  // use these custom strings:
  "application/ifc",
  "application/x-step",
  "model/ifc",
];

const ALLOWED_DESIGN_ENG = [...ALLOWED, ...ALLOWED_CAD];

// The AI-extract / RFQ-import scope (`ai-temp/`) needs the CAD MIME set
// too — IFC files dropped into the AutoFill picker land here BEFORE the
// RFQ row exists, and we still need to upload them before parsing.
const ALLOWED_AI_TEMP = [...ALLOWED, ...ALLOWED_CAD];

// Default cap for everyday uploads (PDFs, images, Excel, supplier docs).
// 500 MB lets the supplier drop multi-page scanned PDFs, big spreadsheets,
// and high-res TIFF photo bundles without hitting the wall.
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB
// CAD / IFC scope cap — real industrial assemblies (full-building IFC,
// loaded CATIA / Inventor assemblies, exported STL meshes from
// optical-detail renders) routinely hit several gigabytes. Vercel Blob's
// hard limit on chunked client uploads is 5 TB; 10 GB here is generous
// without being absurd. web-ifc happily processes 200+ MB files
// server-side, so we're well within what the rest of the stack handles.
const MAX_BYTES_CAD = 10 * 1024 * 1024 * 1024; // 10 GB

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
        if (!profile) {
          throw new Error("Unauthorized");
        }
        // Lock down which paths are allowed so a hostile client can't write
        // outside the expected scopes. `ai-temp/` is for files uploaded by the
        // AI-generation flow before a supplier/competitor exists; they're
        // reattached under the proper scope on save. `clients/<id>/logo/`
        // is for the per-tenant brand mark surfaced on the admin panel.
        if (!/^(suppliers|competitors|ai-temp|design-engineering|clients)\//.test(pathname)) {
          throw new Error("Invalid upload path");
        }
        // Two valid roles can mint a token:
        //   • Lightbase editor — canEdit profile flag (admin / team member).
        //   • Supplier user — signed-in vendor uploading into the `suppliers/`
        //     scope from their portal. Ownership of the specific product /
        //     attachment row is enforced server-side by the matching server
        //     action that records the DB row right after the blob lands; the
        //     blob route just gates the WRITE permission to legitimate users.
        const isSupplierScope = /^suppliers\//.test(pathname);
        const isAllowed =
          canEdit(profile) ||
          (isSupplierUser(profile) && isSupplierScope);
        if (!isAllowed) {
          throw new Error("Unauthorized");
        }
        const isDesignEng = /^design-engineering\//.test(pathname);
        const isAiTemp = /^ai-temp\//.test(pathname);
        // The supplier product catalog uses a category sub-folder in the
        // pathname (e.g. `suppliers/<productId>/drawing/<file>`). When a
        // file lands under the `drawing` category it's a CAD file — STEP,
        // Parasolid, native SolidWorks/Inventor/Catia exports, etc. —
        // which both need the wider MIME allowlist AND the bigger size
        // cap. Other supplier categories (photos, datasheets, certs)
        // keep the safer 50 MB cap so accidental uploads don't bloat
        // the bucket.
        const isSupplierDrawing = /^suppliers\/\d+\/drawing\//.test(pathname);
        return {
          allowedContentTypes: isDesignEng
            ? ALLOWED_DESIGN_ENG
            : isAiTemp
              ? ALLOWED_AI_TEMP
              : isSupplierDrawing
                ? ALLOWED_SUPPLIER_CAD
                : isSupplierScope
                  ? ALLOWED_SUPPLIER
                  : ALLOWED,
          // Bump the size cap for scopes that accept CAD/IFC. Other scopes
          // stay at the conservative 50 MB so a stray PDF can't bloat the
          // bucket.
          maximumSizeInBytes:
            isDesignEng || isAiTemp || isSupplierDrawing ? MAX_BYTES_CAD : MAX_BYTES,
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

// Walks the OneDrive HARDWARES folder, parses every NOMENCLATURE_*.txt
// it finds, and upserts the result into nomenclature_standards. Safe
// to run repeatedly — existing rows are overwritten with the latest
// disk contents so the team's source of truth on OneDrive wins.
//
// Also supports the reverse operation: write a brand-new
// NOMENCLATURE_<TYPE>.txt back to the folder when a user creates a
// standard inside the app (e.g. cable glands), so the CAD team's
// folder stays canonical.
//
// All filesystem access is wrapped in try/catch so the app keeps
// working when the folder isn't reachable (e.g. running in CI or on
// a deployed server without OneDrive mounted) — the user can still
// add standards manually from the UI.

import { promises as fs } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { nomenclatureStandards } from "@/db/schema";
import { ensureNomenclatureSchema } from "./_ensure-schema";

// Configurable so production deploys (where the OneDrive mount path
// will differ from the dev box) can override via env. Falls back to
// hshah's local OneDrive folder so dev "just works".
function hardwaresRoot(): string {
  return (
    process.env.NOMENCLATURE_HARDWARES_PATH ||
    "C:/Users/hasaa/OneDrive - LightBase/Fichiers de Lightbase Group Inc_ - OPERATIONS/PRODUCT DEVELOPMENT/PARTS/HARDWARES"
  );
}

type ParsedStandard = {
  slug: string;
  name: string;
  classCode: string;
  template: string;
  specText: string;
  sourcePath: string;
};

// Very lightweight parse. We trust the file shape:
//   line 1 = template
//   block 2+ = enumerations
//   tail = EXEMPLES section with at least one sample code.
// classCode is derived from the first 2-4 leading-uppercase chars of
// the first example, falling back to the first 3 chars of the slug.
function parseFile(filename: string, raw: string): ParsedStandard | null {
  const base = path.basename(filename, ".txt");
  // NOMENCLATURE_ANCHOR / NOMENCLATURE_SCREW_EXTENDED → "anchor" / "screw"
  const slugMatch = base.match(/^NOMENCLATURE_([A-Z]+)/);
  if (!slugMatch) return null;
  const family = slugMatch[1].toLowerCase();
  const slug = family;
  const name = family
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/s$/, "")
    .concat("s"); // "Anchor" → "Anchors"

  const lines = raw.split(/\r?\n/);
  const template = (lines[0] ?? "").trim();
  if (!template) return null;

  // Find the EXEMPLES section + read the first non-empty line after it.
  let classCode = "";
  const lower = raw.toLowerCase();
  const exIdx = lower.search(/exemples?\s*:/i);
  if (exIdx >= 0) {
    const tail = raw.slice(exIdx).split(/\r?\n/);
    for (const line of tail.slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Skip imperial/metric labels — pick the actual code after the colon.
      const codePart = trimmed.includes(":")
        ? trimmed.split(":").slice(1).join(":").trim()
        : trimmed;
      const first = codePart.split(/[-\s(]/)[0];
      if (first && /^[A-Z]{2,4}$/.test(first)) {
        classCode = first;
        break;
      }
    }
  }
  if (!classCode) classCode = family.slice(0, 3).toUpperCase();

  return {
    slug,
    name,
    classCode,
    template,
    specText: raw,
    sourcePath: filename,
  };
}

export async function scanHardwaresFolder(): Promise<{
  scanned: number;
  imported: number;
  skipped: number;
  errors: Array<{ path: string; message: string }>;
}> {
  await ensureNomenclatureSchema();
  const root = hardwaresRoot();
  const out = { scanned: 0, imported: 0, skipped: 0, errors: [] as Array<{ path: string; message: string }> };
  let subdirs: string[];
  try {
    subdirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch (e) {
    out.errors.push({
      path: root,
      message:
        e instanceof Error
          ? e.message
          : "Folder not reachable from this server",
    });
    return out;
  }

  for (const dir of subdirs) {
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter(
        (f) => f.startsWith("NOMENCLATURE_") && f.endsWith(".txt"),
      );
    } catch (e) {
      out.errors.push({
        path: dir,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dir, file);
      out.scanned++;
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = parseFile(filePath, raw);
        if (!parsed) {
          out.skipped++;
          continue;
        }
        // Upsert by slug — the standards table's unique index makes
        // this a single round-trip.
        const existing = await db
          .select({ id: nomenclatureStandards.id })
          .from(nomenclatureStandards)
          .where(eq(nomenclatureStandards.slug, parsed.slug))
          .limit(1);
        if (existing.length) {
          await db
            .update(nomenclatureStandards)
            .set({
              name: parsed.name,
              classCode: parsed.classCode,
              template: parsed.template,
              specText: parsed.specText,
              sourcePath: parsed.sourcePath,
              updatedAt: new Date(),
            })
            .where(eq(nomenclatureStandards.id, existing[0].id));
        } else {
          await db.insert(nomenclatureStandards).values({
            slug: parsed.slug,
            name: parsed.name,
            classCode: parsed.classCode,
            template: parsed.template,
            specText: parsed.specText,
            sourcePath: parsed.sourcePath,
            userCreated: false,
          });
        }
        out.imported++;
      } catch (e) {
        out.errors.push({
          path: filePath,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return out;
}

// When a user defines a new family in the UI (e.g. "Cable glands"), we
// write a NOMENCLATURE_<UPPER>.txt back to the matching subfolder so
// the CAD team sees it alongside the existing ones. Creates the
// subfolder if needed. Returns the absolute path written.
export async function writeNewStandardFile(args: {
  slug: string;
  name: string;
  classCode: string;
  template: string;
  specText: string;
}): Promise<string | null> {
  const root = hardwaresRoot();
  const folder = args.name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  const dir = path.join(root, folder);
  const filename = `NOMENCLATURE_${args.slug.toUpperCase()}.txt`;
  const filePath = path.join(dir, filename);
  // Match the existing files' shape: template line, blank line, the
  // standard substitution legend, then the body.
  const body = [
    args.template,
    "",
    "/=_ ",
    ".=,",
    "",
    args.specText.trim(),
  ].join("\n");
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, body, "utf8");
    return filePath;
  } catch (e) {
    console.warn(
      `[nomenclature] Could not write ${filePath}:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";

/** Cap input size sent to the model so a 50-page catalog doesn't burn tokens. */
const MAX_TEXT_CHARS = 60_000;

export type ParsedSource = {
  /** Original filename or URL — included verbatim in the prompt for context. */
  label: string;
  /** Plain text representation (cleaned/extracted) the model will read. */
  text: string;
  /** Optional base64 image data for vision-capable inputs (images only). */
  imageDataUrl?: string;
};

/** Truncate text for the model. We add a marker so it knows it was cut. */
function clip(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + "\n\n…[content truncated]";
}

/** Extract text from a PDF buffer. Returns an empty string for scanned PDFs. */
export async function pdfBufferToText(buf: Buffer | Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return clip((result.text ?? "").trim());
  } catch (e) {
    console.error("pdf-parse failed", e);
    return "";
  }
}

/** Convert an Excel/CSV buffer to readable text. Joins all sheets with headers. */
export function xlsxBufferToText(buf: Buffer | Uint8Array, hint?: string): string {
  try {
    const wb = XLSX.read(buf, { type: "array" });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) parts.push(`# Sheet: ${sheetName}\n${csv}`);
    }
    return clip(parts.join("\n\n"));
  } catch (e) {
    console.error("xlsx parse failed", e, hint);
    return "";
  }
}

/** Fetch a URL and crudely strip HTML to readable text. */
export async function fetchUrlAsText(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 Lightbase Supplier Manager",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  // Treat non-HTML/text responses as opaque — fall back to filename only.
  if (!ct.includes("text") && !ct.includes("json") && !ct.includes("xml")) {
    return `[Binary content at ${url} — content-type ${ct}]`;
  }
  const html = await res.text();
  // Strip script/style/nav blocks completely, then tags.
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return clip(stripped);
}

export function isPdf(mime: string, name: string): boolean {
  return mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}
export function isSpreadsheet(mime: string, name: string): boolean {
  const n = name.toLowerCase();
  return (
    mime.includes("spreadsheet") ||
    mime === "text/csv" ||
    n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv") || n.endsWith(".tsv")
  );
}
export function isImage(mime: string, name: string): boolean {
  return mime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/**
 * Take a raw uploaded file (or already-fetched URL bytes) and convert it into
 * something the model can ingest: text, or a vision image.
 */
export async function parseFile(
  buf: Buffer | Uint8Array,
  mime: string,
  name: string,
): Promise<ParsedSource> {
  if (isPdf(mime, name)) {
    return { label: name, text: await pdfBufferToText(buf) };
  }
  if (isSpreadsheet(mime, name)) {
    return { label: name, text: xlsxBufferToText(buf, name) };
  }
  if (isImage(mime, name)) {
    const b64 = Buffer.from(buf).toString("base64");
    const dataUrl = `data:${mime || "image/png"};base64,${b64}`;
    return { label: name, text: "[image attached]", imageDataUrl: dataUrl };
  }
  // Plain-ish text file
  const text = clip(Buffer.from(buf).toString("utf8"));
  return { label: name, text };
}

"use server";

// AI extraction for the RFQ workflow. Two extraction targets:
//
//   1. parseRfqItemsFromUpload  → fills the buyer's "Line items" table
//      when they upload an existing RFQ Excel/PDF (e.g. the legacy
//      template the team used to email manually).
//
//   2. parseQuoteFromUpload     → fills the supplier's quote form when
//      they upload their own quotation PDF/Excel from the vendor portal.
//
// Excel rows are parsed locally with `xlsx` and handed to Claude as plain
// JSON so token cost stays low. PDFs are sent to Claude as native
// document content blocks (no text-extraction layer) so tables and
// figures survive the round-trip.

import * as XLSX from "xlsx";
import {
  CLAUDE_FALLBACK_MODELS,
  CLAUDE_MODEL,
  claudeClient,
  hasClaudeKey,
} from "@/lib/ai/claude";
import type { Rfq } from "@/db/schema";
import { requireSupplierEditor } from "@/lib/permissions";
import { ensureOrdersSchema } from "./_ensure-orders-schema";
import type { RfqItemInput } from "./rfq-actions";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUpload(url: string): Promise<{ buffer: Buffer; mime: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch upload (HTTP ${r.status})`);
  const mime = r.headers.get("content-type") ?? "application/octet-stream";
  const arr = new Uint8Array(await r.arrayBuffer());
  return { buffer: Buffer.from(arr), mime };
}

function isExcel(mime: string, name?: string): boolean {
  const n = (name ?? "").toLowerCase();
  return (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "text/csv" ||
    n.endsWith(".xlsx") ||
    n.endsWith(".xls") ||
    n.endsWith(".csv")
  );
}

function isPdf(mime: string, name?: string): boolean {
  return (
    mime === "application/pdf" || (name ?? "").toLowerCase().endsWith(".pdf")
  );
}

function excelToText(buf: Buffer): string {
  // Convert the workbook to a JSON array per sheet — short and structured
  // beats raw bytes (≈10× cheaper in tokens).
  const wb = XLSX.read(buf, { type: "buffer" });
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Array<string | number | null>>(ws, {
      header: 1,
      blankrows: false,
    });
    out.push(`# Sheet: ${sheetName}`);
    for (const row of rows.slice(0, 200)) {
      out.push(
        row
          .map((c) => (c == null ? "" : String(c)))
          .join("\t")
          .trimEnd(),
      );
    }
    out.push("");
  }
  return out.join("\n").slice(0, 30_000);
}

async function callClaudeWithTool<T>(opts: {
  systemPrompt: string;
  userText?: string;
  pdf?: { base64: string; mediaType: "application/pdf" };
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  if (!hasClaudeKey()) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const client = claudeClient();
  const models = [CLAUDE_MODEL, ...CLAUDE_FALLBACK_MODELS];

  const userContent: Array<
    | { type: "text"; text: string }
    | {
        type: "document";
        source: { type: "base64"; media_type: "application/pdf"; data: string };
      }
  > = [];
  if (opts.pdf) {
    userContent.push({
      type: "document",
      source: {
        type: "base64",
        media_type: opts.pdf.mediaType,
        data: opts.pdf.base64,
      },
    });
  }
  if (opts.userText) {
    userContent.push({ type: "text", text: opts.userText });
  }

  let lastErr: unknown = null;
  for (const model of models) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.systemPrompt,
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription,
            input_schema: opts.toolSchema as never,
          },
        ],
        tool_choice: { type: "tool", name: opts.toolName },
        messages: [{ role: "user", content: userContent }],
      });
      const block = res.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new Error("Claude returned no tool_use block");
      }
      return block.input as T;
    } catch (e) {
      lastErr = e;
      // Try the next model only on "not_found" / "permission" / "invalid"
      // — anything else (rate limit, billing) propagates.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/not_found|permission|invalid|model/i.test(msg)) throw e;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "Claude call failed"));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. RFQ items (buyer side) — upload existing template → fill line items
// ─────────────────────────────────────────────────────────────────────────────

const RFQ_ITEMS_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectNum: { type: "string", description: "Project number / RFQ ref if visible on the document. Empty if absent." },
    projectName: { type: "string", description: "Project name (e.g. 'Ledco'). Empty if absent." },
    niche: { type: "string", description: "Product niche / category. Empty if absent." },
    targetCurrency: { type: "string", description: "Currency code (USD / CAD / EUR / CNY). Default USD." },
    incoterms: { type: "string", description: "FOB / EXW / DAP / DDP etc. Empty if absent." },
    transportMode: {
      type: "string",
      enum: ["air", "sea", "truck", "rail", "courier", "any"],
      description: "Transport preference. Use 'any' if not specified.",
    },
    notes: { type: "string", description: "Free-form notes / additional context." },
    items: {
      type: "array",
      description: "One row per RFQ line item. Empty array if no items found.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          clientRef: { type: "string", description: "Internal/customer reference code (e.g. 'L18SM')" },
          productCode: { type: "string", description: "Supplier/manufacturer product code if present" },
          description: { type: "string", description: "Free-form product description / specifications" },
          specifications: { type: "string", description: "Additional spec details if separate from description" },
          qty: { type: "integer", minimum: 1 },
          securityStock: { type: "integer", minimum: 0 },
          targetUnitPrice: { type: "number", description: "Target unit price if listed; omit if not" },
          productUrl: { type: "string", description: "Manufacturer/product URL if present" },
        },
        required: ["description", "qty"],
      },
    },
  },
  required: ["items"],
};

export type ParsedRfq = {
  projectNum?: string;
  projectName?: string;
  niche?: string;
  targetCurrency?: string;
  incoterms?: string;
  transportMode?: Rfq["transportMode"];
  notes?: string;
  items: RfqItemInput[];
};

export async function parseRfqItemsFromUpload(input: {
  url: string;
  fileName?: string;
}): Promise<ParsedRfq> {
  await requireSupplierEditor();
  await ensureOrdersSchema();
  const { buffer, mime } = await fetchUpload(input.url);

  const systemPrompt = `You are an RFQ extraction assistant for an electrical / lighting manufacturer.
Given an existing RFQ document (Excel or PDF), extract the project context and the line items into the provided JSON tool.
Line items typically have: client/internal ref, product code, free-form spec (face size, length, voltage, CCT, mounting, etc.), QTY, security stock.
Be strict: only return rows that look like actual product lines. Skip headers, footers, signatures, totals.
If a field is not visible on the document, omit it from the output (don't invent).`;

  let userText: string | undefined;
  let pdf: { base64: string; mediaType: "application/pdf" } | undefined;
  if (isExcel(mime, input.fileName)) {
    userText = `Source file: ${input.fileName ?? "uploaded.xlsx"}\n\nWorkbook contents (tab-separated rows):\n${excelToText(buffer)}`;
  } else if (isPdf(mime, input.fileName)) {
    pdf = { base64: buffer.toString("base64"), mediaType: "application/pdf" };
    userText = `Source file: ${input.fileName ?? "uploaded.pdf"}\n\nExtract the RFQ project info + every line item from this PDF.`;
  } else {
    throw new Error(`Unsupported file type for RFQ extraction: ${mime}. Use PDF or Excel/CSV.`);
  }

  const parsed = await callClaudeWithTool<ParsedRfq>({
    systemPrompt,
    userText,
    pdf,
    toolName: "submit_rfq_extraction",
    toolDescription: "Submit the parsed RFQ project info + line items.",
    toolSchema: RFQ_ITEMS_TOOL_SCHEMA,
  });

  // Sanitize — Claude sometimes returns empty strings for missing fields
  // even when the schema says omit.
  const items = (parsed.items ?? [])
    .filter((it) => (it.description ?? "").trim().length > 0 && (it.qty ?? 0) > 0)
    .map((it) => ({
      clientRef: it.clientRef?.trim() || undefined,
      productCode: it.productCode?.trim() || undefined,
      description: it.description.trim(),
      specifications: it.specifications?.trim() || undefined,
      qty: Math.max(1, it.qty | 0),
      securityStock: Math.max(0, it.securityStock ?? 0),
      targetUnitPrice: it.targetUnitPrice ?? null,
      productUrl: it.productUrl?.trim() || undefined,
    }));

  return {
    projectNum: parsed.projectNum?.trim() || undefined,
    projectName: parsed.projectName?.trim() || undefined,
    niche: parsed.niche?.trim() || undefined,
    targetCurrency: parsed.targetCurrency?.trim() || undefined,
    incoterms: parsed.incoterms?.trim() || undefined,
    transportMode: parsed.transportMode,
    notes: parsed.notes?.trim() || undefined,
    items,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Quote extraction (supplier side) — upload quote PDF → fill quote form
// ─────────────────────────────────────────────────────────────────────────────

const QUOTE_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    companyName: { type: "string" },
    contactName: { type: "string" },
    contactEmail: { type: "string" },
    contactPhone: { type: "string" },
    address: { type: "string" },
    countryOfOrigin: { type: "string" },
    manufacturerName: { type: "string" },
    manufacturerPartNumber: { type: "string" },
    currency: { type: "string", description: "Currency code (USD / CAD / EUR / CNY / etc.)" },
    incoterms: { type: "string" },
    transportMode: {
      type: "string",
      enum: ["air", "sea", "truck", "rail", "courier", "any"],
    },
    shippingCost: { type: "number" },
    leadTimeDays: { type: "integer", minimum: 0 },
    validityUntil: { type: "string", description: "ISO date (YYYY-MM-DD) if a validity is mentioned" },
    notes: { type: "string" },
    lines: {
      type: "array",
      description: "Per-item pricing pulled from the quote. One row per line item.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          clientRef: { type: "string", description: "Buyer's ref code if visible (lets us match to the RFQ item)" },
          description: { type: "string", description: "Product description so we can fuzzy-match to RFQ items" },
          unitPrice: { type: "number", minimum: 0 },
          moq: { type: "integer", minimum: 1 },
          availableStock: { type: "integer", minimum: 0 },
          leadTimeDays: { type: "integer", minimum: 0 },
          notes: { type: "string" },
        },
        required: ["unitPrice"],
      },
    },
  },
  required: [],
};

export type ParsedQuote = {
  companyName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  countryOfOrigin?: string;
  manufacturerName?: string;
  manufacturerPartNumber?: string;
  currency?: string;
  incoterms?: string;
  transportMode?: Rfq["transportMode"];
  shippingCost?: number;
  leadTimeDays?: number;
  validityUntil?: string;
  notes?: string;
  lines: Array<{
    clientRef?: string;
    description?: string;
    unitPrice: number;
    moq?: number;
    availableStock?: number;
    leadTimeDays?: number;
    notes?: string;
  }>;
};

// Token-gated public entry — used by the vendor portal upload-extract flow.
// No Clerk auth (the supplier doesn't have an internal account). Validates
// the token before doing the AI call so randoms can't drive cost.
export async function parseQuoteFromUpload(input: {
  token: string;
  url: string;
  fileName?: string;
}): Promise<ParsedQuote> {
  await ensureOrdersSchema();
  // Verify the token belongs to a real rfq_recipient row (cheap query).
  const { db } = await import("@/db");
  const { rfqRecipients } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [recipient] = await db
    .select()
    .from(rfqRecipients)
    .where(eq(rfqRecipients.accessToken, input.token))
    .limit(1);
  if (!recipient || (recipient.tokenExpiresAt && recipient.tokenExpiresAt < new Date())) {
    throw new Error("Invalid or expired portal token");
  }

  const { buffer, mime } = await fetchUpload(input.url);

  const systemPrompt = `You are a quotation extraction assistant for a procurement platform.
Given a supplier's quotation document (PDF or Excel), extract the structured fields needed to fill our quote form.
Be conservative: only return what's clearly stated. Omit fields you can't read.
For per-line pricing, return one entry per product line on the quote.`;

  let userText: string | undefined;
  let pdf: { base64: string; mediaType: "application/pdf" } | undefined;
  if (isExcel(mime, input.fileName)) {
    userText = `Source: ${input.fileName ?? "quote.xlsx"}\n\nWorkbook contents:\n${excelToText(buffer)}`;
  } else if (isPdf(mime, input.fileName)) {
    pdf = { base64: buffer.toString("base64"), mediaType: "application/pdf" };
    userText = `Source: ${input.fileName ?? "quote.pdf"}\n\nExtract the supplier quote fields + per-item pricing.`;
  } else {
    throw new Error(`Unsupported file type for quote extraction: ${mime}. Use PDF or Excel/CSV.`);
  }

  const parsed = await callClaudeWithTool<ParsedQuote>({
    systemPrompt,
    userText,
    pdf,
    toolName: "submit_quote_extraction",
    toolDescription: "Submit the parsed supplier quote fields + per-line pricing.",
    toolSchema: QUOTE_TOOL_SCHEMA,
  });

  return {
    ...parsed,
    lines: (parsed.lines ?? []).filter((l) => l.unitPrice > 0),
  };
}

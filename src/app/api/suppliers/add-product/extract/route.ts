// Streaming extract endpoint for the Supplier Catalogue add-product flow.
// Mirrors /api/competitors/add-product:
//   POST body: { url, supplierHint?, categoryHint? }
//   On the wire: SSE lines, one JSON object per "data:" line:
//     { type: "progress", step, detail, percent }
//     { type: "done",     result }   // AddSupplierProductExtractResult
//     { type: "error",    message }

import {
  extractSupplierProductStreaming,
  type AddSupplierProductProgress,
} from "@/app/suppliers/add-product-actions";
import {
  getOrCreateProfile,
  canViewSuppliers,
  canEdit,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sseLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

type Body = {
  url?: string;
  supplierHint?: string;
  categoryHint?: string;
};

export async function POST(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewSuppliers(profile) || !canEdit(profile)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = body.url?.trim();
  if (!url) {
    return new Response(JSON.stringify({ error: "url is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        } catch {
          closed = true;
        }
      }, 5_000);

      try {
        safeEnqueue(
          sseLine({
            type: "progress",
            step: "starting",
            percent: 0,
            detail: null,
          }),
        );
        const onProgress = (e: AddSupplierProductProgress) => {
          safeEnqueue(sseLine({ type: "progress", ...e }));
        };
        const result = await extractSupplierProductStreaming({
          url,
          supplierHint: body.supplierHint,
          categoryHint: body.categoryHint,
          onProgress,
        });
        safeEnqueue(sseLine({ type: "done", result }));
      } catch (e) {
        safeEnqueue(
          sseLine({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

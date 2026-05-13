// Streaming endpoint for the "Extract documents" button on the product
// drawer. Crawls the product's source URL for downloadable files (specs,
// IES, CAD, brochures…), attaches them to the product row, and then auto-
// re-runs Claude spec analysis on the PDFs to fill the spec fields.
//
// Mirrors /api/competitors/add-product: SSE envelope, 5-min timeout,
// heartbeat, self-healing schema for migration 0018.

import {
  aiExtractProductFilesStreaming,
  type ExtractProductFilesProgress,
} from "@/app/competitors/research-actions";
import type { ProductFilesResult } from "@/app/competitors/research-actions";
import { ensureCompetitorProductsSchema } from "@/app/competitors/_attachments";
import {
  getOrCreateProfile,
  canViewCompetitors,
  canEdit,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sseLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export async function POST(request: Request) {
  const profile = await getOrCreateProfile();
  if (!profile || !canViewCompetitors(profile) || !canEdit(profile)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: cannot edit competitors" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  let input: { productId: number };
  try {
    input = (await request.json()) as { productId: number };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (typeof input?.productId !== "number") {
    return new Response(
      JSON.stringify({ error: "productId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  await ensureCompetitorProductsSchema();

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
        const onProgress = (e: ExtractProductFilesProgress) => {
          safeEnqueue(sseLine({ type: "progress", ...e }));
        };

        safeEnqueue(
          sseLine({
            type: "progress",
            step: "starting",
            detail: "Authorising & preparing…",
            percent: 1,
          }),
        );

        const result: ProductFilesResult = await aiExtractProductFilesStreaming(
          input,
          { onProgress, signal: request.signal },
        );

        if (result.ok) {
          safeEnqueue(sseLine({ type: "done", result }));
        } else {
          safeEnqueue(sseLine({ type: "error", message: result.error }));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        safeEnqueue(sseLine({ type: "error", message }));
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      /* request.signal will propagate via aiExtractProductFilesStreaming */
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

// Streaming endpoint for the "Add product from URL" flow on /competitors.
// Consumed by AddProductForm, which posts the same shape as the server
// action `aiAddProductFromInput` and reads server-sent events back to
// render the §5 progress UX (% bar, elapsed/ETA, current-step label,
// heartbeat, cancel). The server-action remains in place for any caller
// that prefers a single round-trip.
//
// Event envelope on the wire (one JSON object per SSE "data:" line):
//   { type: "progress", step, detail, percent }
//   { type: "done",     result }              // AddProductResult (ok: true)
//   { type: "error",    message }
//
// The Route Handler runtime stays Node (default) — we need access to the
// db, Vercel Blob `put`, and Anthropic/OpenAI SDKs, none of which work on
// edge.

import {
  aiAddProductFromInputStreaming,
  type AddProductInput,
  type AddProductProgress,
  type AddProductResult,
} from "@/app/competitors/add-actions";
import { ensureCompetitorProductsSchema } from "@/app/competitors/_attachments";
import { getOrCreateProfile, canViewCompetitors, canEdit } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // up to 5 min — matches Vercel Pro streaming limit

function sseLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export async function POST(request: Request) {
  // Auth — same gate as the server-action.
  const profile = await getOrCreateProfile();
  if (!profile || !canViewCompetitors(profile) || !canEdit(profile)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: cannot edit competitors" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  let input: AddProductInput;
  try {
    input = (await request.json()) as AddProductInput;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (typeof input?.collectionId !== "number") {
    return new Response(
      JSON.stringify({ error: "collectionId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Self-heal the schema before processing: idempotently apply migration
  // 0018 (specs_analysis_hash) if it hasn't been applied yet. This means
  // a deploy that ships a code-schema change WITHOUT also running
  // `npm run db:apply` against prod no longer leaves Add-Product broken.
  // The compat helpers downstream catch any case where this fails too.
  await ensureCompetitorProductsSchema();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Client disconnected — flag closed so subsequent events no-op.
          closed = true;
        }
      };

      // §5.1 heartbeat: emit a no-op comment every 5s so the connection
      // stays warm through long AI calls (some proxies kill idle SSE).
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        } catch {
          closed = true;
        }
      }, 5_000);

      try {
        const onProgress = (e: AddProductProgress) => {
          safeEnqueue(sseLine({ type: "progress", ...e }));
        };

        // Initial 0% so the client can show the bar immediately rather
        // than waiting for the first real milestone.
        safeEnqueue(
          sseLine({
            type: "progress",
            step: "starting",
            detail: "Authorizing & preparing inputs…",
            percent: 1,
          }),
        );

        const result: AddProductResult = await aiAddProductFromInputStreaming(
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
          /* already closed by disconnect */
        }
      }
    },
    cancel() {
      // Client disconnected (cancel button, tab close). The aborted
      // request.signal propagates into aiAddProductFromInputStreaming
      // and throws AbortError, which the try/catch above turns into a
      // best-effort `error` event before the stream closes.
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

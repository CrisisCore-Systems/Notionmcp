import { NextRequest } from "next/server";
import { runResearchAgent } from "@/lib/agent";
import { isAbortError, onAbort } from "@/lib/abort";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const maxDuration = 120; // 2 minute timeout for research phase

export async function POST(req: NextRequest) {
  const requestError = validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const { prompt } = await req.json();

  if (!prompt?.trim()) {
    return new Response(JSON.stringify({ error: "Prompt is required" }), {
      status: 400,
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) {
          return;
        }

        closed = true;
        controller.close();
      };
      const send = (event: string, data: unknown) => {
        if (closed) {
          return;
        }

        controller.enqueue(
          encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          )
        );
      };
      const removeAbortListener = onAbort(req.signal, close);

      try {
        const result = await runResearchAgent(prompt, (message) => {
          send("update", { message });
        }, req.signal);

        if (!req.signal.aborted) {
          send("complete", result);
        }
      } catch (err) {
        if (!isAbortError(err) && !req.signal.aborted) {
          send("error", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        removeAbortListener();
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

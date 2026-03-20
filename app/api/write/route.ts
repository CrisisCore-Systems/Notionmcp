import { NextRequest } from "next/server";
import type { ResearchResult } from "@/lib/agent";
import { addRow, createDatabase } from "@/lib/notion-mcp";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<ResearchResult>;
  const suggestedDbTitle = body.suggestedDbTitle?.trim();
  const summary = body.summary?.trim();
  const schema = body.schema;
  const items = body.items;

  if (
    !suggestedDbTitle ||
    !summary ||
    !schema ||
    typeof schema !== "object" ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return new Response(JSON.stringify({ error: "A complete research result is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        send("update", { message: `Creating Notion database "${suggestedDbTitle}"...` });
        const databaseId = await createDatabase(suggestedDbTitle, schema);

        for (let index = 0; index < items.length; index++) {
          await addRow(databaseId, items[index] ?? {}, schema);
          send("update", {
            message: `Added row ${index + 1} of ${items.length}`,
          });
        }

        send("complete", {
          databaseId,
          message: `✅ Created Notion database and wrote ${items.length} row${items.length === 1 ? "" : "s"}`,
        });
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
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

import { NextRequest } from "next/server";
import type { ResearchResult } from "@/lib/agent";
import { addRow, createDatabase } from "@/lib/notion-mcp";

export const runtime = "nodejs";
export const maxDuration = 120;

const NOTION_PROPERTY_TYPES = new Set([
  "title",
  "rich_text",
  "url",
  "number",
  "select",
]);

function isValidDatabaseId(value: string): boolean {
  return (
    /^[a-f0-9]{32}$/i.test(value) ||
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}

/** Validate the streamed research payload before writing anything to Notion. */
function isResearchResult(value: unknown): value is ResearchResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const schema = candidate.schema;
  const items = candidate.items;

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }

  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every((item) => item && typeof item === "object" && !Array.isArray(item))
  ) {
    return false;
  }

  return (
    typeof candidate.suggestedDbTitle === "string" &&
    typeof candidate.summary === "string" &&
    Object.values(schema).every(
      (propertyType) =>
        typeof propertyType === "string" && NOTION_PROPERTY_TYPES.has(propertyType)
    )
  );
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as unknown;

  if (!isResearchResult(body)) {
    return new Response(JSON.stringify({ error: "A complete research result is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const suggestedDbTitle = body.suggestedDbTitle.trim();
  const summary = body.summary.trim();
  const schema = body.schema;
  const items = body.items;
  const candidate = body as unknown as Record<string, unknown>;
  const targetDatabaseId =
    typeof candidate.targetDatabaseId === "string"
      ? candidate.targetDatabaseId.trim()
      : "";

  if (!suggestedDbTitle || !summary) {
    return new Response(JSON.stringify({ error: "A complete research result is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  if (targetDatabaseId && !isValidDatabaseId(targetDatabaseId)) {
    return new Response(JSON.stringify({ error: "A valid Notion database ID is required" }), {
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
        let databaseId = targetDatabaseId;

        if (databaseId) {
          send("update", { message: `Using existing Notion database "${databaseId}"...` });
        } else {
          send("update", { message: `Creating Notion database "${suggestedDbTitle}"...` });
          databaseId = await createDatabase(suggestedDbTitle, schema);
        }

        for (let index = 0; index < items.length; index++) {
          await addRow(databaseId, items[index], schema);
          send("update", {
            message: `Added row ${index + 1} of ${items.length}`,
          });
        }

        send("complete", {
          databaseId,
          message: targetDatabaseId
            ? `✅ Added ${items.length} row${items.length === 1 ? "" : "s"} to the existing Notion database`
            : `✅ Created Notion database and wrote ${items.length} row${items.length === 1 ? "" : "s"}`,
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

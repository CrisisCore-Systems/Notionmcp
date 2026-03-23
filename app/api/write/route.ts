import { NextRequest } from "next/server";
import {
  addRow,
  createDatabase,
  createDuplicateTracker,
  type DuplicateTracker,
  type NotionSchema,
} from "@/lib/notion-mcp";
import { validateApiRequest } from "@/lib/request-security";
import { runWithRetry } from "@/lib/retry";
import { isValidDatabaseId, parseResearchResult } from "@/lib/write-payload";

export const runtime = "nodejs";
export const maxDuration = 120;

const ROW_WRITE_MAX_ATTEMPTS = 3;
const ROW_WRITE_RETRY_DELAY_MS = 750;

async function addRowWithRetry(
  databaseId: string,
  data: Record<string, string>,
  schema: NotionSchema,
  rowIndex: number,
  duplicateTracker: DuplicateTracker
): Promise<{ attempt: number; duplicate: boolean }> {
  try {
    const { attempt, value } = await runWithRetry(
      () => addRow(databaseId, data, schema, duplicateTracker),
      {
        maxAttempts: ROW_WRITE_MAX_ATTEMPTS,
        retryDelayMs: ROW_WRITE_RETRY_DELAY_MS,
      }
    );

    return { attempt, duplicate: !value.created };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to write row ${rowIndex + 1} after ${ROW_WRITE_MAX_ATTEMPTS} attempts: ${message}`
    );
  }
}

export async function POST(req: NextRequest) {
  const requestError = validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const body = (await req.json()) as unknown;

  const candidate = body as unknown as Record<string, unknown>;
  const targetDatabaseId =
    typeof candidate.targetDatabaseId === "string"
      ? candidate.targetDatabaseId.trim()
      : "";
  const resumeFromIndex =
    typeof candidate.resumeFromIndex === "number" ? candidate.resumeFromIndex : 0;

  if (!Number.isInteger(resumeFromIndex) || resumeFromIndex < 0) {
    return new Response(JSON.stringify({ error: "resumeFromIndex must be a non-negative integer" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  let normalizedBody: ReturnType<typeof parseResearchResult>;

  try {
    normalizedBody = parseResearchResult(body);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "A complete research result is required",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  const suggestedDbTitle = normalizedBody.suggestedDbTitle;
  const summary = normalizedBody.summary;
  const schema = normalizedBody.schema;
  const items = normalizedBody.items;

  if (!suggestedDbTitle || !summary) {
    return new Response(JSON.stringify({ error: "A complete research result is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  if (resumeFromIndex > 0 && !targetDatabaseId) {
    return new Response(
      JSON.stringify({ error: "targetDatabaseId is required when resuming a partial write" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  if (resumeFromIndex > items.length) {
    return new Response(
      JSON.stringify({ error: "resumeFromIndex cannot be greater than the number of items" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
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
      let databaseId = targetDatabaseId;
      let nextRowIndex = resumeFromIndex;
      let duplicateTracker: DuplicateTracker | null = null;
      let itemsWritten = 0;
      let itemsSkipped = 0;

      try {
        if (databaseId) {
          send("update", { message: `Using existing Notion database "${databaseId}"...` });
        } else {
          send("update", { message: `Creating Notion database "${suggestedDbTitle}"...` });
          databaseId = await createDatabase(suggestedDbTitle, schema);
        }

        duplicateTracker = await createDuplicateTracker(databaseId, schema, {
          prefetchExisting: !!targetDatabaseId,
        });

        if (resumeFromIndex > 0) {
          send("update", {
            message: `Resuming Notion write from row ${resumeFromIndex + 1} of ${items.length}...`,
          });
        }

        for (let index = resumeFromIndex; index < items.length; index++) {
          nextRowIndex = index;
          const { attempt, duplicate } = await addRowWithRetry(
            databaseId,
            items[index],
            schema,
            index,
            duplicateTracker
          );

          if (duplicate) {
            itemsSkipped += 1;
          } else {
            itemsWritten += 1;
          }

          send("update", {
            message:
              duplicate
                ? `Skipped row ${index + 1} of ${items.length} because a matching Notion entry already exists`
                : attempt > 1
                ? `Added row ${index + 1} of ${items.length} after ${attempt} attempts`
                : `Added row ${index + 1} of ${items.length}`,
          });
        }

        send("complete", {
          databaseId,
          itemsWritten,
          itemsSkipped,
          propertyCount: Object.keys(schema).length,
          usedExistingDatabase: !!targetDatabaseId,
          resumedFromIndex: resumeFromIndex,
          message: targetDatabaseId
            ? `✅ Added ${itemsWritten} row${itemsWritten === 1 ? "" : "s"} to the existing Notion database${itemsSkipped > 0 ? ` and skipped ${itemsSkipped} duplicate${itemsSkipped === 1 ? "" : "s"}` : ""}`
            : `✅ Created Notion database and wrote ${itemsWritten} row${itemsWritten === 1 ? "" : "s"}${itemsSkipped > 0 ? ` while skipping ${itemsSkipped} duplicate${itemsSkipped === 1 ? "" : "s"}` : ""}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        send("error", {
          message,
          databaseId: databaseId || undefined,
          nextRowIndex,
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

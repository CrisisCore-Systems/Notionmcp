import { NextRequest } from "next/server";
import { addRow, createDatabase, type NotionSchema } from "@/lib/notion-mcp";
import { validateApiRequest } from "@/lib/request-security";
import {
  isResearchResult,
  isValidDatabaseId,
  normalizeResearchResult,
} from "@/lib/write-payload";

export const runtime = "nodejs";
export const maxDuration = 120;

const ROW_WRITE_MAX_ATTEMPTS = 3;
const ROW_WRITE_RETRY_DELAY_MS = 750;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function addRowWithRetry(
  databaseId: string,
  data: Record<string, string>,
  schema: NotionSchema,
  rowIndex: number
): Promise<{ attempt: number; duplicate: boolean }> {
  let attempt = 0;

  while (attempt < ROW_WRITE_MAX_ATTEMPTS) {
    attempt += 1;

    try {
      const result = await addRow(databaseId, data, schema);
      return { attempt, duplicate: !result.created };
    } catch (error) {
      if (attempt >= ROW_WRITE_MAX_ATTEMPTS) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to write row ${rowIndex + 1} after ${ROW_WRITE_MAX_ATTEMPTS} attempts: ${message}`
        );
      }

      await sleep(ROW_WRITE_RETRY_DELAY_MS * attempt);
    }
  }

  return { attempt: ROW_WRITE_MAX_ATTEMPTS, duplicate: false };
}

export async function POST(req: NextRequest) {
  const requestError = validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const body = (await req.json()) as unknown;

  if (!isResearchResult(body)) {
    return new Response(JSON.stringify({ error: "A complete research result is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

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

  let normalizedBody: ReturnType<typeof normalizeResearchResult>;

  try {
    normalizedBody = normalizeResearchResult(body);
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

      try {
        if (databaseId) {
          send("update", { message: `Using existing Notion database "${databaseId}"...` });
        } else {
          send("update", { message: `Creating Notion database "${suggestedDbTitle}"...` });
          databaseId = await createDatabase(suggestedDbTitle, schema);
        }

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
            index
          );
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
          itemsWritten: items.length - resumeFromIndex,
          propertyCount: Object.keys(schema).length,
          usedExistingDatabase: !!targetDatabaseId,
          resumedFromIndex: resumeFromIndex,
          message: targetDatabaseId
            ? `✅ Added ${items.length - resumeFromIndex} row${items.length - resumeFromIndex === 1 ? "" : "s"} to the existing Notion database`
            : `✅ Created Notion database and wrote ${items.length - resumeFromIndex} row${items.length - resumeFromIndex === 1 ? "" : "s"}`,
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

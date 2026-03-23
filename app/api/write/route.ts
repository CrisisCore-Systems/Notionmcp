import { NextRequest } from "next/server";
import { isAbortError, onAbort, throwIfAborted } from "@/lib/abort";
import {
  addRow,
  createDatabase,
  createDuplicateTracker,
  type DuplicateTracker,
  type NotionSchema,
} from "@/lib/notion-mcp";
import { validateApiRequest } from "@/lib/request-security";
import { isRetryableUpstreamError, runWithRetry } from "@/lib/retry";
import type { ResearchItem } from "@/lib/research-result";
import { isValidDatabaseId, parseResearchResult } from "@/lib/write-payload";

export const runtime = "nodejs";
export const maxDuration = 120;

const ROW_WRITE_MAX_ATTEMPTS = 3;
const ROW_WRITE_RETRY_DELAY_MS = 750;

function formatWriteCompleteMessage(
  usedExistingDatabase: boolean,
  itemsWritten: number,
  itemsSkipped: number
): string {
  const duplicateSuffix =
    itemsSkipped > 0
      ? `${usedExistingDatabase ? " and skipped " : " while skipping "}${itemsSkipped} duplicate${itemsSkipped === 1 ? "" : "s"}`
      : "";

  return usedExistingDatabase
    ? `✅ Added ${itemsWritten} row${itemsWritten === 1 ? "" : "s"} to the existing Notion database${duplicateSuffix}`
    : `✅ Created Notion database and wrote ${itemsWritten} row${itemsWritten === 1 ? "" : "s"}${duplicateSuffix}`;
}

async function addRowWithRetry(
  databaseId: string,
  data: ResearchItem,
  schema: NotionSchema,
  rowIndex: number,
  duplicateTracker: DuplicateTracker,
  signal?: AbortSignal
): Promise<{ attempt: number; duplicate: boolean }> {
  try {
    const { attempt, value } = await runWithRetry(
      () => addRow(databaseId, data, schema, duplicateTracker),
      {
        maxAttempts: ROW_WRITE_MAX_ATTEMPTS,
        retryDelayMs: ROW_WRITE_RETRY_DELAY_MS,
        shouldRetry: (error) => isRetryableUpstreamError(error),
        signal,
      }
    );

    return { attempt, duplicate: !value.created };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryableUpstreamError(error);
    throw new Error(
      retryable
        ? `Failed to write row ${rowIndex + 1} after ${ROW_WRITE_MAX_ATTEMPTS} attempts: ${message}`
        : `Failed to write row ${rowIndex + 1} without retry because the upstream error is permanent: ${message}`
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

  if (targetDatabaseId && !isValidDatabaseId(targetDatabaseId)) {
    return new Response(JSON.stringify({ error: "A valid Notion database ID is required" }), {
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
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      const removeAbortListener = onAbort(req.signal, close);
      let databaseId = targetDatabaseId;
      let nextRowIndex = resumeFromIndex;
      let duplicateTracker: DuplicateTracker | null = null;
      let itemsWritten = 0;
      let itemsSkipped = 0;

      try {
        throwIfAborted(req.signal, "Write request cancelled by client.");

        if (databaseId) {
          send("update", { message: `Using existing Notion database "${databaseId}"...` });
        } else {
          send("update", { message: `Creating Notion database "${suggestedDbTitle}"...` });
          databaseId = await createDatabase(suggestedDbTitle, schema);
        }

        throwIfAborted(req.signal, "Write request cancelled by client.");
        duplicateTracker = await createDuplicateTracker(databaseId, schema, {
          prefetchExisting: !!targetDatabaseId,
        });

        if (resumeFromIndex > 0) {
          send("update", {
            message: `Resuming Notion write from row ${resumeFromIndex + 1} of ${items.length}...`,
          });
        }

        for (let index = resumeFromIndex; index < items.length; index++) {
          throwIfAborted(req.signal, "Write request cancelled by client.");
          nextRowIndex = index;
          const { attempt, duplicate } = await addRowWithRetry(
            databaseId,
            items[index],
            schema,
            index,
            duplicateTracker,
            req.signal
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
          message: formatWriteCompleteMessage(!!targetDatabaseId, itemsWritten, itemsSkipped),
        });
      } catch (err) {
        if (!isAbortError(err) && !req.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);

          send("error", {
            message,
            databaseId: databaseId || undefined,
            nextRowIndex,
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

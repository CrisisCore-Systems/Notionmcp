import { NextRequest } from "next/server";
import {
  addRow,
  buildOperationalSchema,
  createDatabase,
  createDuplicateTracker,
  type DuplicateTracker,
  type NotionSchema,
  getDatabaseMetadataSupport,
  type NotionWriteMetadataSupport,
} from "@/lib/notion-mcp";
import { validateApiRequest } from "@/lib/request-security";
import { isRetryableUpstreamError, runWithRetry } from "@/lib/retry";
import type { ResearchItem } from "@/lib/research-result";
import {
  buildRowWriteMetadata,
  buildWriteAuditTrail,
  type RowWriteAuditEntry,
  type RowWriteMetadata,
} from "@/lib/write-audit";
import { buildWriteAuditUrl, persistWriteAuditRecord } from "@/lib/write-audit-store";
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
  writeMetadata: RowWriteMetadata,
  metadataSupport: NotionWriteMetadataSupport
): Promise<{ attempt: number; duplicate: boolean }> {
  try {
    const { attempt, value } = await runWithRetry(
      () => addRow(databaseId, data, schema, duplicateTracker, writeMetadata, metadataSupport),
      {
        maxAttempts: ROW_WRITE_MAX_ATTEMPTS,
        retryDelayMs: ROW_WRITE_RETRY_DELAY_MS,
        shouldRetry: (error) => isRetryableUpstreamError(error),
      }
    );

    return { attempt, duplicate: !value.created };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryableUpstreamError(error);
    throw new Error(
      retryable
        ? `Failed to write row ${rowIndex + 1} after ${ROW_WRITE_MAX_ATTEMPTS} attempts: ${message}`
        : `Failed to write row ${rowIndex + 1} without retry because the upstream error is permanent: ${message}`
    );
  }
}

function buildRowAuditEntries(
  operationKeys: string[],
  startIndex: number,
  totalRows: number,
  confirmedWrittenRows: Set<number>,
  duplicateRows: Set<number>
): RowWriteAuditEntry[] {
  const entries: RowWriteAuditEntry[] = [];

  for (let index = startIndex; index < totalRows; index++) {
    entries.push({
      rowIndex: index,
      operationKey: operationKeys[index] ?? "",
      status: confirmedWrittenRows.has(index)
        ? "written"
        : duplicateRows.has(index)
          ? "duplicate"
          : "unresolved",
    });
  }

  return entries;
}

function buildDuplicateTrackerOptions(
  operationKeySupport: boolean,
  operationKeys: string[],
  useExistingDatabase: boolean
) {
  return {
    prefetchExisting: useExistingDatabase && !operationKeySupport,
    useOperationKeyLookup: useExistingDatabase && operationKeySupport,
    operationKeys,
  };
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
  const rowWriteMetadata = items.map((item) => buildRowWriteMetadata(item, schema));
  const operationKeys = rowWriteMetadata.map((entry) => entry.operationKey);

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
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      const startedAtMs = Date.now();
      let databaseId = targetDatabaseId;
      let nextRowIndex = resumeFromIndex;
      let duplicateTracker: DuplicateTracker | null = null;
      let metadataSupport: NotionWriteMetadataSupport = {
        operationKey: false,
        sourceSet: false,
        confidenceScore: false,
        evidenceSummary: false,
      };
      let rowsAttempted = 0;
      const confirmedWrittenRows = new Set<number>();
      const duplicateRows = new Set<number>();

      try {
        if (databaseId) {
          send("update", { message: `Using existing Notion database "${databaseId}"...` });
          metadataSupport = await getDatabaseMetadataSupport(databaseId);
        } else {
          send("update", { message: `Creating Notion database "${suggestedDbTitle}"...` });
          databaseId = await createDatabase(suggestedDbTitle, buildOperationalSchema(schema));
          metadataSupport = {
            operationKey: true,
            sourceSet: true,
            confidenceScore: true,
            evidenceSummary: true,
          };
        }

        duplicateTracker = await createDuplicateTracker(databaseId, schema, {
          ...buildDuplicateTrackerOptions(
            metadataSupport.operationKey,
            operationKeys.slice(resumeFromIndex),
            !!targetDatabaseId
          ),
        });

        if (resumeFromIndex > 0) {
          send("update", {
            message: `Resuming Notion write from row ${resumeFromIndex + 1} of ${items.length}...`,
          });
        }

        for (let index = resumeFromIndex; index < items.length; index++) {
          nextRowIndex = index;
          rowsAttempted += 1;
          const { attempt, duplicate } = await addRowWithRetry(
            databaseId,
            items[index],
            schema,
            index,
            duplicateTracker,
            rowWriteMetadata[index] as RowWriteMetadata,
            metadataSupport
          );

          if (duplicate) {
            duplicateRows.add(index);
          } else {
            confirmedWrittenRows.add(index);
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

        send("update", {
          message: `📊 Write finished in ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s with ${
            confirmedWrittenRows.size
          } row${confirmedWrittenRows.size === 1 ? "" : "s"} written and ${duplicateRows.size} duplicate${
            duplicateRows.size === 1 ? "" : "s"
          } skipped.`,
        });
        const auditTrail = buildWriteAuditTrail(
          normalizedBody,
          buildRowAuditEntries(operationKeys, resumeFromIndex, items.length, confirmedWrittenRows, duplicateRows),
          rowsAttempted
        );
        const persistedAudit = await persistWriteAuditRecord({
          databaseId,
          status: "complete",
          usedExistingDatabase: !!targetDatabaseId,
          resumedFromIndex: resumeFromIndex,
          message: formatWriteCompleteMessage(
            !!targetDatabaseId,
            confirmedWrittenRows.size,
            duplicateRows.size
          ),
          auditTrail,
        });
        send("complete", {
          databaseId,
          itemsWritten: confirmedWrittenRows.size,
          itemsSkipped: duplicateRows.size,
          propertyCount: Object.keys(schema).length,
          usedExistingDatabase: !!targetDatabaseId,
          resumedFromIndex: resumeFromIndex,
          message: formatWriteCompleteMessage(
            !!targetDatabaseId,
            confirmedWrittenRows.size,
            duplicateRows.size
          ),
          auditId: persistedAudit.id,
          auditUrl: buildWriteAuditUrl(persistedAudit.id),
          auditTrail,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let reconciled = false;

        if (databaseId && nextRowIndex < items.length) {
          try {
            const reconciliationTracker = await createDuplicateTracker(databaseId, schema, {
              ...buildDuplicateTrackerOptions(
                metadataSupport.operationKey,
                [operationKeys[nextRowIndex] ?? ""],
                true
              ),
            });

            if (reconciliationTracker.has(items[nextRowIndex] as ResearchItem, operationKeys[nextRowIndex])) {
              confirmedWrittenRows.add(nextRowIndex);
              nextRowIndex += 1;
              reconciled = true;
              send("update", {
                message: `🧭 Reconciliation confirmed row ${nextRowIndex} landed in Notion. Future retries will start from row ${
                  nextRowIndex + 1
                }.`,
              });
            }
          } catch (reconciliationError) {
            send("update", {
              message: `⚠️ Reconciliation check failed: ${
                reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)
              }`,
            });
          }
        }

        const auditTrail = buildWriteAuditTrail(
          normalizedBody,
          buildRowAuditEntries(operationKeys, resumeFromIndex, items.length, confirmedWrittenRows, duplicateRows),
          rowsAttempted
        );
        const persistedAudit = await persistWriteAuditRecord({
          databaseId: databaseId || undefined,
          status: databaseId && nextRowIndex >= items.length ? "complete" : "error",
          usedExistingDatabase: !!targetDatabaseId,
          resumedFromIndex: resumeFromIndex,
          nextRowIndex: databaseId && nextRowIndex < items.length ? nextRowIndex : undefined,
          message: reconciled
            ? `${message} Reconciliation verified the last ambiguous row before pausing.`
            : message,
          auditTrail,
        });

        if (databaseId && nextRowIndex >= items.length) {
          send("complete", {
            databaseId,
            itemsWritten: confirmedWrittenRows.size,
            itemsSkipped: duplicateRows.size,
            propertyCount: Object.keys(schema).length,
            usedExistingDatabase: !!targetDatabaseId,
            resumedFromIndex: resumeFromIndex,
            message: formatWriteCompleteMessage(
              !!targetDatabaseId,
              confirmedWrittenRows.size,
              duplicateRows.size
            ),
            auditId: persistedAudit.id,
            auditUrl: buildWriteAuditUrl(persistedAudit.id),
            auditTrail,
          });
          return;
        }

        send("error", {
          message: reconciled
            ? `${message} Reconciliation verified the last ambiguous row before pausing.`
            : message,
          databaseId: databaseId || undefined,
          nextRowIndex,
          auditId: persistedAudit.id,
          auditUrl: buildWriteAuditUrl(persistedAudit.id),
          auditTrail,
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

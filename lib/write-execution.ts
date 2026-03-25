import {
  addRow,
  buildOperationalSchema,
  createDatabase,
  createDuplicateTracker,
  getCurrentNotionProviderState,
  getConfiguredNotionProviderMode,
  getDatabaseMetadataSupport,
  type DuplicateTracker,
  type NotionSchema,
  type NotionWriteMetadataSupport,
} from "@/lib/notion";
import { isRetryableUpstreamError, runWithRetry } from "@/lib/retry";
import type { ResearchItem, ResearchResult } from "@/lib/research-result";
import {
  buildRowWriteMetadata,
  buildWriteAuditTrail,
  type RowWriteAuditEntry,
  type RowWriteMetadata,
} from "@/lib/write-audit";
import {
  assertPersistedWriteAuditRecordInvariants,
  assertWriteExecutionSuccessInvariants,
} from "@/lib/write-invariants";
import {
  buildWriteAuditUrl,
  persistWriteAuditRecord,
  saveWriteAuditRecord,
  type PersistedWriteAuditRecord,
} from "@/lib/write-audit-store";

const ROW_WRITE_MAX_ATTEMPTS = 3;
const ROW_WRITE_RETRY_DELAY_MS = 750;

export type WriteExecutionInput = ResearchResult & {
  targetDatabaseId?: string;
  resumeFromIndex?: number;
};

export type WriteExecutionSuccess = {
  databaseId: string;
  itemsWritten: number;
  itemsSkipped: number;
  propertyCount: number;
  usedExistingDatabase: boolean;
  resumedFromIndex: number;
  message: string;
  auditId: string;
  auditUrl: string;
  auditTrail: ReturnType<typeof buildWriteAuditTrail>;
  providerMode: ReturnType<typeof getConfiguredNotionProviderMode>;
};

export type WriteExecutionErrorDetails = {
  message: string;
  databaseId?: string;
  nextRowIndex?: number;
  auditId?: string;
  auditUrl?: string;
  auditTrail?: ReturnType<typeof buildWriteAuditTrail>;
  providerMode: ReturnType<typeof getConfiguredNotionProviderMode>;
};

export class WriteExecutionError extends Error {
  details: WriteExecutionErrorDetails;

  constructor(details: WriteExecutionErrorDetails) {
    super(details.message);
    this.name = "WriteExecutionError";
    this.details = details;
  }
}

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
  rowWriteMetadata: RowWriteMetadata[],
  startIndex: number,
  totalRows: number,
  confirmedWrittenRows: Set<number>,
  duplicateRows: Set<number>,
  reconciledRows: Set<number>
): RowWriteAuditEntry[] {
  const entries: RowWriteAuditEntry[] = [];

  for (let index = startIndex; index < totalRows; index++) {
    const rowMetadata = rowWriteMetadata[index];
    entries.push({
      rowIndex: index,
      operationKey: rowMetadata?.operationKey ?? "",
      status: confirmedWrittenRows.has(index)
        ? reconciledRows.has(index)
          ? "written-after-reconciliation"
          : "written"
        : duplicateRows.has(index)
          ? "duplicate"
          : "unresolved",
      evidenceSummary: rowMetadata?.evidenceSummary,
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

export async function executeWriteJob(
  payload: WriteExecutionInput,
  callbacks: {
    onUpdate: (message: string, checkpoint?: { databaseId?: string; nextRowIndex?: number }) => Promise<void> | void;
  }
): Promise<WriteExecutionSuccess> {
  const startedAtMs = Date.now();
  const providerMode = getConfiguredNotionProviderMode();
  const providerState = getCurrentNotionProviderState();
  const targetDatabaseId = payload.targetDatabaseId?.trim() || "";
  const resumeFromIndex = payload.resumeFromIndex ?? 0;
  const suggestedDbTitle = payload.suggestedDbTitle;
  const schema = payload.schema;
  const items = payload.items;
  const rowWriteMetadata = items.map((item) => buildRowWriteMetadata(item, schema));
  const operationKeys = rowWriteMetadata.map((entry) => entry.operationKey);
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
  const reconciledRows = new Set<number>();
  let persistedAudit: PersistedWriteAuditRecord = await persistWriteAuditRecord(
    assertPersistedWriteAuditRecordInvariants({
      databaseId: databaseId || undefined,
      status: "running",
      usedExistingDatabase: !!targetDatabaseId,
      resumedFromIndex: resumeFromIndex,
      nextRowIndex,
      providerMode,
      message:
        resumeFromIndex > 0
          ? `Running resumed reviewed write from row ${resumeFromIndex + 1}.`
          : "Running reviewed write with persisted audit trail.",
      auditTrail: buildWriteAuditTrail(
        payload,
        buildRowAuditEntries(
          rowWriteMetadata,
          resumeFromIndex,
          items.length,
          confirmedWrittenRows,
          duplicateRows,
          reconciledRows
        ),
        rowsAttempted
      ),
    })
  );

  await callbacks.onUpdate(
    `Using Notion provider lane: ${providerMode} (${providerState.posture === "canonical" ? "canonical direct API" : "legacy compatibility fallback"}).`,
    {
      nextRowIndex: resumeFromIndex,
    }
  );

  try {
    if (databaseId) {
      await callbacks.onUpdate(`Using existing Notion database "${databaseId}"...`, {
        databaseId,
        nextRowIndex,
      });
      metadataSupport = await getDatabaseMetadataSupport(databaseId);
    } else {
      await callbacks.onUpdate(`Creating Notion database "${suggestedDbTitle}"...`, {
        nextRowIndex,
      });
      databaseId = await createDatabase(suggestedDbTitle, buildOperationalSchema(schema));
      metadataSupport = {
        operationKey: true,
        sourceSet: true,
        confidenceScore: true,
        evidenceSummary: true,
      };
      await callbacks.onUpdate(`Created Notion database "${databaseId}".`, {
        databaseId,
        nextRowIndex,
      });
    }

    duplicateTracker = await createDuplicateTracker(databaseId, schema, {
      ...buildDuplicateTrackerOptions(
        metadataSupport.operationKey,
        operationKeys.slice(resumeFromIndex),
        !!targetDatabaseId
      ),
    });

    if (resumeFromIndex > 0) {
      await callbacks.onUpdate(
        `Resuming Notion write from row ${resumeFromIndex + 1} of ${items.length}...`,
        {
          databaseId,
          nextRowIndex: resumeFromIndex,
        }
      );
    }

    for (let index = resumeFromIndex; index < items.length; index++) {
      nextRowIndex = index;
      rowsAttempted += 1;
      const { attempt, duplicate } = await addRowWithRetry(
        databaseId,
        items[index] as ResearchItem,
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

      nextRowIndex = index + 1;
      await callbacks.onUpdate(
        duplicate
          ? `Skipped row ${index + 1} of ${items.length} because a matching Notion entry already exists`
          : attempt > 1
            ? `Added row ${index + 1} of ${items.length} after ${attempt} attempts`
            : `Added row ${index + 1} of ${items.length}`,
        {
          databaseId,
          nextRowIndex,
        }
      );
    }

    const auditTrail = buildWriteAuditTrail(
      payload,
      buildRowAuditEntries(
        rowWriteMetadata,
        resumeFromIndex,
        items.length,
        confirmedWrittenRows,
        duplicateRows,
        reconciledRows
      ),
      rowsAttempted
    );
    const message = formatWriteCompleteMessage(
      !!targetDatabaseId,
      confirmedWrittenRows.size,
      duplicateRows.size
    );
    persistedAudit = await saveWriteAuditRecord(
      assertPersistedWriteAuditRecordInvariants(
        {
          ...persistedAudit,
          databaseId,
          status: "complete",
          usedExistingDatabase: !!targetDatabaseId,
          resumedFromIndex: resumeFromIndex,
          nextRowIndex,
          providerMode,
          message,
          auditTrail,
        },
        persistedAudit
      ) as PersistedWriteAuditRecord
    );

    await callbacks.onUpdate(
      `📊 Write finished in ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s with ${confirmedWrittenRows.size} row${
        confirmedWrittenRows.size === 1 ? "" : "s"
      } written and ${duplicateRows.size} duplicate${duplicateRows.size === 1 ? "" : "s"} skipped.`,
      {
        databaseId,
        nextRowIndex,
      }
    );

    return assertWriteExecutionSuccessInvariants({
      databaseId,
      itemsWritten: confirmedWrittenRows.size,
      itemsSkipped: duplicateRows.size,
      propertyCount: Object.keys(schema).length,
      usedExistingDatabase: !!targetDatabaseId,
      resumedFromIndex: resumeFromIndex,
      message,
      auditId: persistedAudit.id,
      auditUrl: buildWriteAuditUrl(persistedAudit.id),
      auditTrail,
      providerMode,
    }, persistedAudit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
          reconciledRows.add(nextRowIndex);
          nextRowIndex += 1;
          reconciled = true;
          await callbacks.onUpdate(
            `🧭 Reconciliation confirmed row ${nextRowIndex} landed in Notion. Future retries will start from row ${
              nextRowIndex + 1
            }.`,
            {
              databaseId,
              nextRowIndex,
            }
          );
        }
      } catch (reconciliationError) {
        await callbacks.onUpdate(
          `⚠️ Reconciliation check failed: ${
            reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)
          }`,
          {
            databaseId,
            nextRowIndex,
          }
        );
      }
    }

    const auditTrail = buildWriteAuditTrail(
      payload,
      buildRowAuditEntries(
        rowWriteMetadata,
        resumeFromIndex,
        items.length,
        confirmedWrittenRows,
        duplicateRows,
        reconciledRows
      ),
      rowsAttempted
    );
    const errorMessage = reconciled
      ? `${message} Reconciliation verified the last ambiguous row before pausing.`
      : message;
    persistedAudit = await saveWriteAuditRecord(
      assertPersistedWriteAuditRecordInvariants(
        {
          ...persistedAudit,
          databaseId: databaseId || undefined,
          status: databaseId && nextRowIndex >= items.length ? "complete" : "error",
          usedExistingDatabase: !!targetDatabaseId,
          resumedFromIndex: resumeFromIndex,
          nextRowIndex: databaseId ? nextRowIndex : undefined,
          providerMode,
          message: errorMessage,
          auditTrail,
        },
        persistedAudit
      ) as PersistedWriteAuditRecord
    );

    if (databaseId && nextRowIndex >= items.length) {
      return assertWriteExecutionSuccessInvariants({
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
        providerMode,
      }, persistedAudit);
    }

    throw new WriteExecutionError({
      message: errorMessage,
      databaseId: databaseId || undefined,
      nextRowIndex: databaseId && nextRowIndex < items.length ? nextRowIndex : undefined,
      auditId: persistedAudit.id,
      auditUrl: buildWriteAuditUrl(persistedAudit.id),
      auditTrail,
      providerMode,
    });
  }
}

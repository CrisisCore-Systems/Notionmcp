import { createHash } from "node:crypto";
import type { NotionSchema } from "@/lib/notion/provider";
import {
  RESEARCH_ITEM_PROVENANCE_KEY,
  RESEARCH_RUN_METADATA_KEY,
  type ResearchExtractionCounts,
  type ResearchItem,
  type ResearchResult,
} from "@/lib/research-result";
import { assertWriteAuditTrailInvariants } from "@/lib/write-invariants";

export interface RowWriteMetadata {
  operationKey: string;
  sourceSet: string;
  confidenceScore: number;
  evidenceSummary: string;
}

export type RowWriteStatus = "written" | "written-after-reconciliation" | "duplicate" | "unresolved";

export interface RowWriteAuditEntry {
  rowIndex: number;
  operationKey: string;
  status: RowWriteStatus;
  evidenceSummary?: string;
}

export interface WriteAuditTrail {
  sourceSet: string[];
  extractionCounts: ResearchExtractionCounts;
  rejectedUrls: string[];
  rowsReviewed: number;
  rowsAttempted: number;
  rowsConfirmedWritten: number;
  rowsConfirmedAfterReconciliation: number;
  rowsSkippedAsDuplicates: number;
  rowsLeftUnresolved: number;
  rows: RowWriteAuditEntry[];
}

function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => {
        const entry = value[key];

        if (Array.isArray(entry)) {
          return [key, [...entry].sort()];
        }

        if (entry && typeof entry === "object") {
          return [key, sortRecord(entry as Record<string, unknown>)];
        }

        return [key, entry];
      })
  );
}

function getPopulatedFieldNames(item: ResearchItem, schema: NotionSchema): string[] {
  return Object.keys(schema).filter((key) => typeof item[key] === "string" && item[key].trim().length > 0);
}

function deriveSourceSetFromItems(items: ResearchItem[]): string[] {
  const sourceSet = new Set<string>();

  for (const item of items) {
    for (const url of item[RESEARCH_ITEM_PROVENANCE_KEY]?.sourceUrls ?? []) {
      if (url) {
        sourceSet.add(url);
      }
    }
  }

  return Array.from(sourceSet).sort((left, right) => left.localeCompare(right));
}

function deriveExtractionCounts(result: ResearchResult): ResearchExtractionCounts {
  return {
    searchQueries: 0,
    candidateSources: deriveSourceSetFromItems(result.items).length,
    pagesBrowsed: deriveSourceSetFromItems(result.items).length,
    rowsExtracted: result.items.length,
  };
}

export function buildDeterministicOperationKey(item: ResearchItem, schema: NotionSchema): string {
  const normalizedPayload = {
    fields: Object.fromEntries(
      Object.keys(schema)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, typeof item[key] === "string" ? item[key].trim() : ""])
    ),
    provenance: sortRecord({
      sourceUrls: [...(item[RESEARCH_ITEM_PROVENANCE_KEY]?.sourceUrls ?? [])].sort(),
      evidenceByField: item[RESEARCH_ITEM_PROVENANCE_KEY]?.evidenceByField ?? {},
    }),
  };

  return createHash("sha256").update(JSON.stringify(normalizedPayload)).digest("hex");
}

export function calculateRowConfidenceScore(item: ResearchItem, schema: NotionSchema): number {
  const populatedFields = getPopulatedFieldNames(item, schema);

  if (populatedFields.length === 0) {
    return 0;
  }

  const evidenceByField = item[RESEARCH_ITEM_PROVENANCE_KEY]?.evidenceByField ?? {};
  const evidencedFieldCount = populatedFields.filter(
    (fieldName) => (evidenceByField[fieldName] ?? []).filter(Boolean).length > 0
  ).length;

  return Math.round((evidencedFieldCount / populatedFields.length) * 100);
}

export function buildRowWriteMetadata(item: ResearchItem, schema: NotionSchema): RowWriteMetadata {
  const operationKey = buildDeterministicOperationKey(item, schema);
  const sourceSet = item[RESEARCH_ITEM_PROVENANCE_KEY]?.sourceUrls?.join("\n") ?? "";
  const evidenceByField = item[RESEARCH_ITEM_PROVENANCE_KEY]?.evidenceByField ?? {};
  const evidencedFields = Object.keys(evidenceByField).sort((left, right) => left.localeCompare(right));
  const evidenceSummary =
    evidencedFields.length > 0
      ? `Evidence for ${evidencedFields.length} field${evidencedFields.length === 1 ? "" : "s"}: ${evidencedFields.join(", ")}`
      : "Evidence summary unavailable";

  return {
    operationKey,
    sourceSet,
    confidenceScore: calculateRowConfidenceScore(item, schema),
    evidenceSummary,
  };
}

export function buildWriteAuditTrail(
  result: ResearchResult,
  rowStatuses: RowWriteAuditEntry[],
  rowsAttempted: number
): WriteAuditTrail {
  const metadata = result[RESEARCH_RUN_METADATA_KEY];
  const sourceSet = metadata?.sourceSet?.length ? metadata.sourceSet : deriveSourceSetFromItems(result.items);
  const extractionCounts = metadata?.extractionCounts ?? deriveExtractionCounts(result);
  const rejectedUrls = metadata?.rejectedUrls ?? [];

  return assertWriteAuditTrailInvariants({
    sourceSet,
    extractionCounts,
    rejectedUrls,
    rowsReviewed: result.items.length,
    rowsAttempted,
    rowsConfirmedWritten: rowStatuses.filter(
      (row) => row.status === "written" || row.status === "written-after-reconciliation"
    ).length,
    rowsConfirmedAfterReconciliation: rowStatuses.filter(
      (row) => row.status === "written-after-reconciliation"
    ).length,
    rowsSkippedAsDuplicates: rowStatuses.filter((row) => row.status === "duplicate").length,
    rowsLeftUnresolved: rowStatuses.filter((row) => row.status === "unresolved").length,
    rows: rowStatuses,
  });
}

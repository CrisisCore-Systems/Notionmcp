import type { ResearchResult } from "@/lib/agent";
import type { WriteAuditTrail } from "@/lib/write-audit";

export type Phase = "idle" | "researching" | "approving" | "writing" | "done" | "error";
export type PropertyType = "title" | "rich_text" | "url" | "number" | "select";

export type EditableResult = ResearchResult & {
  schema: Record<string, PropertyType>;
};

export type WritePayload = EditableResult & {
  targetDatabaseId?: string;
  resumeFromIndex?: number;
  notionParentPageId?: string;
};

export type PendingWriteResume = {
  databaseId: string;
  nextRowIndex: number;
};

export type StoredDraft = {
  prompt: string;
  editedResult: EditableResult;
  useExistingDatabase: boolean;
  targetDatabaseId: string;
  notionParentPageId: string;
  pendingWriteResume: PendingWriteResume | null;
};

export type ValidationIssue = {
  rowIndex: number;
  columnName: string;
  message: string;
};

export type WriteSummary = {
  jobId?: string;
  jobUrl?: string;
  databaseId: string;
  itemsWritten: number;
  propertyCount: number;
  usedExistingDatabase: boolean;
  providerMode?: string;
  auditId?: string;
  auditUrl?: string;
  auditTrail?: WriteAuditTrail;
  notionQueue?: {
    databaseId: string;
    pageId: string;
    title: string;
    claimedBy: string;
    claimedAt?: string;
    runId: string;
  };
  research?: {
    mode?: "fast" | "deep";
    degraded: boolean;
    uniqueDomainCount: number;
    sourceClassCount: number;
    averageQualityScore?: number;
    rejectedUrlCount: number;
    usedProviders: string[];
  };
};

export type StreamErrorPayload = {
  message: string;
  databaseId?: string;
  nextRowIndex?: number;
  auditId?: string;
  auditUrl?: string;
};

export interface LogEntry {
  id: string;
  type: "info" | "success" | "error";
  message: string;
}

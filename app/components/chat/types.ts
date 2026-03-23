import type { ResearchResult } from "@/lib/agent";

export type Phase = "idle" | "researching" | "approving" | "writing" | "done" | "error";
export type PropertyType = "title" | "rich_text" | "url" | "number" | "select";

export type EditableResult = ResearchResult & {
  schema: Record<string, PropertyType>;
};

export type WritePayload = EditableResult & {
  targetDatabaseId?: string;
  resumeFromIndex?: number;
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
  pendingWriteResume: PendingWriteResume | null;
};

export type ValidationIssue = {
  rowIndex: number;
  columnName: string;
  message: string;
};

export type WriteSummary = {
  databaseId: string;
  itemsWritten: number;
  propertyCount: number;
  usedExistingDatabase: boolean;
  auditId?: string;
  auditUrl?: string;
};

export type StreamErrorPayload = {
  message: string;
  databaseId?: string;
  nextRowIndex?: number;
  auditId?: string;
  auditUrl?: string;
};

export interface LogEntry {
  type: "info" | "success" | "error";
  message: string;
}

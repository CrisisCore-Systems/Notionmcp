"use client";

import { useMemo } from "react";
import { isValidDatabaseId } from "@/lib/notion-validation";
import { getValidationIssues } from "./chat-utils";
import type { EditableResult, PendingWriteResume, PropertyType, ValidationIssue } from "./types";

type UseApprovalValidationOptions = {
  editedResult: EditableResult | null;
  useExistingDatabase: boolean;
  targetDatabaseId: string;
  pendingWriteResume: PendingWriteResume | null;
};

type ApprovalValidationState = {
  schemaEntries: Array<[string, PropertyType]>;
  titleFieldCount: number;
  targetDatabaseValid: boolean;
  validationIssues: ValidationIssue[];
  invalidCellLookup: Set<string>;
  canWrite: boolean;
  approvalHint: string | null;
};

export function useApprovalValidation({
  editedResult,
  useExistingDatabase,
  targetDatabaseId,
  pendingWriteResume,
}: UseApprovalValidationOptions): ApprovalValidationState {
  const schemaEntries = useMemo(
    () =>
      editedResult
        ? (Object.entries(editedResult.schema) as Array<[string, PropertyType]>)
        : [],
    [editedResult]
  );
  const titleFieldCount = schemaEntries.filter(([, type]) => type === "title").length;
  const hasSchema = schemaEntries.length > 0;
  const targetDatabaseValid =
    !!pendingWriteResume || !useExistingDatabase || isValidDatabaseId(targetDatabaseId.trim());
  const validationIssues = useMemo(
    () => (editedResult ? getValidationIssues(editedResult) : []),
    [editedResult]
  );
  const invalidCellLookup = useMemo(() => {
    const lookup = new Set<string>();

    for (const issue of validationIssues) {
      lookup.add(`${issue.rowIndex}:${issue.columnName}`);
    }

    return lookup;
  }, [validationIssues]);
  const canWrite =
    !!editedResult &&
    editedResult.items.length > 0 &&
    hasSchema &&
    titleFieldCount === 1 &&
    !!editedResult.suggestedDbTitle.trim() &&
    !!editedResult.summary.trim() &&
    targetDatabaseValid &&
    validationIssues.length === 0;

  let approvalHint: string | null = null;
  if (editedResult) {
    if (titleFieldCount !== 1) {
      approvalHint = "Your schema must contain exactly one title field before writing to Notion.";
    } else if (!targetDatabaseValid) {
      approvalHint = "Enter a valid existing Notion database ID or switch back to creating a new database.";
    } else if (validationIssues.length > 0) {
      approvalHint = validationIssues[0]?.message ?? "Fix the highlighted cells before writing to Notion.";
    } else if (!editedResult.summary.trim()) {
      approvalHint = "Add a summary before writing to Notion.";
    } else if (!editedResult.suggestedDbTitle.trim()) {
      approvalHint = "Add a database title before writing to Notion.";
    }
  }

  return {
    schemaEntries,
    titleFieldCount,
    targetDatabaseValid,
    validationIssues,
    invalidCellLookup,
    canWrite,
    approvalHint,
  };
}

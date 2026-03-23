import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useApprovalValidation } from "@/app/components/chat/useApprovalValidation";
import type { EditableResult, PendingWriteResume, PropertyType } from "@/app/components/chat/types";

type ValidationState = ReturnType<typeof useApprovalValidation>;

function renderApprovalValidation({
  editedResult,
  useExistingDatabase,
  targetDatabaseId,
  pendingWriteResume,
}: {
  editedResult: EditableResult | null;
  useExistingDatabase: boolean;
  targetDatabaseId: string;
  pendingWriteResume: PendingWriteResume | null;
}): ValidationState {
  let capturedState: ValidationState | null = null;

  function Probe() {
    capturedState = useApprovalValidation({
      editedResult,
      useExistingDatabase,
      targetDatabaseId,
      pendingWriteResume,
    });

    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  if (!capturedState) {
    throw new Error("Approval validation state was not captured.");
  }

  return capturedState;
}

function createEditableResult(): EditableResult {
  return {
    suggestedDbTitle: "Research",
    summary: "Summary",
    schema: {
      Name: "title" as PropertyType,
      Description: "rich_text" as PropertyType,
    },
    items: [
      {
        Name: "Alpha",
        Description: "Alpha summary",
        __provenance: {
          sourceUrls: ["https://example.com"],
          evidenceByField: {
            Name: ["Alpha is named on the page"],
            Description: ["The summary is listed on the page"],
          },
        },
      },
    ],
  };
}

test("useApprovalValidation rejects invalid existing Notion database IDs on the client", () => {
  const validation = renderApprovalValidation({
    editedResult: createEditableResult(),
    useExistingDatabase: true,
    targetDatabaseId: "not-a-real-database-id",
    pendingWriteResume: null,
  });

  assert.equal(validation.targetDatabaseValid, false);
  assert.equal(validation.canWrite, false);
  assert.match(validation.approvalHint ?? "", /valid existing Notion database ID/);
});

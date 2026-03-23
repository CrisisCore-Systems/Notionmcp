import assert from "node:assert/strict";
import test from "node:test";
import { buildDeterministicOperationKey, buildWriteAuditTrail } from "@/lib/write-audit";

test("buildDeterministicOperationKey is stable across equivalent row ordering", () => {
  const schema = {
    Name: "title",
    URL: "url",
    Summary: "rich_text",
  } as const;

  const first = buildDeterministicOperationKey(
    {
      Name: "Alpha",
      URL: "https://example.com/alpha",
      Summary: "Research summary",
      __provenance: {
        sourceUrls: ["https://example.com/about", "https://example.com/alpha"],
        evidenceByField: {
          Summary: ["Evidence for summary"],
          Name: ["Evidence for name"],
        },
      },
    },
    schema
  );
  const second = buildDeterministicOperationKey(
    {
      URL: "https://example.com/alpha",
      Summary: "Research summary",
      Name: "Alpha",
      __provenance: {
        sourceUrls: ["https://example.com/alpha", "https://example.com/about"],
        evidenceByField: {
          Name: ["Evidence for name"],
          Summary: ["Evidence for summary"],
        },
      },
    },
    schema
  );

  assert.equal(first, second);
});

test("buildWriteAuditTrail reports confirmed, duplicate, and unresolved rows", () => {
  const auditTrail = buildWriteAuditTrail(
    {
      suggestedDbTitle: "Research",
      summary: "Summary",
      schema: { Name: "title" },
      items: [
        {
          Name: "Alpha",
          __provenance: {
            sourceUrls: ["https://example.com/a"],
            evidenceByField: {
              Name: ["Alpha evidence"],
            },
          },
        },
        {
          Name: "Beta",
          __provenance: {
            sourceUrls: ["https://example.com/b"],
            evidenceByField: {
              Name: ["Beta evidence"],
            },
          },
        },
        {
          Name: "Gamma",
          __provenance: {
            sourceUrls: ["https://example.com/c"],
            evidenceByField: {
              Name: ["Gamma evidence"],
            },
          },
        },
      ],
      __runMetadata: {
        sourceSet: ["https://example.com/a", "https://example.com/b"],
        extractionCounts: {
          searchQueries: 2,
          candidateSources: 5,
          pagesBrowsed: 3,
          rowsExtracted: 3,
        },
        rejectedUrls: ["https://example.com/blocked"],
      },
    },
    [
      { rowIndex: 0, operationKey: "k1", status: "written" },
      { rowIndex: 1, operationKey: "k2", status: "duplicate" },
      { rowIndex: 2, operationKey: "k3", status: "unresolved" },
    ],
    2
  );

  assert.deepEqual(auditTrail.sourceSet, ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(auditTrail.rejectedUrls, ["https://example.com/blocked"]);
  assert.deepEqual(auditTrail.extractionCounts, {
    searchQueries: 2,
    candidateSources: 5,
    pagesBrowsed: 3,
    rowsExtracted: 3,
  });
  assert.equal(auditTrail.rowsAttempted, 2);
  assert.equal(auditTrail.rowsConfirmedWritten, 1);
  assert.equal(auditTrail.rowsSkippedAsDuplicates, 1);
  assert.equal(auditTrail.rowsLeftUnresolved, 1);
});

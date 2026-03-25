import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { notionTestOverrides, type NotionProvider } from "@/lib/notion";
import type { PersistedWriteAuditRecord } from "@/lib/write-audit-store";
import { executeWriteJob } from "@/lib/write-execution";
import { loadWriteAuditRecord } from "@/lib/write-audit-store";
import { buildDeterministicOperationKey, buildWriteAuditTrail } from "@/lib/write-audit";
import { assertPersistedWriteAuditRecordInvariants } from "@/lib/write-invariants";

const ORIGINAL_ENV = { ...process.env };

test.afterEach(async () => {
  const auditDir = process.env.WRITE_AUDIT_DIR;
  process.env = { ...ORIGINAL_ENV };
  delete notionTestOverrides.provider;

  if (auditDir?.startsWith(path.join(os.tmpdir(), "notionmcp-write-invariants-"))) {
    await rm(auditDir, { recursive: true, force: true });
  }
});

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
      {
        rowIndex: 0,
        operationKey: "k1",
        status: "written-after-reconciliation",
        evidenceSummary: "Evidence for 1 field: Name",
      },
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
  assert.equal(auditTrail.rowsReviewed, 3);
  assert.equal(auditTrail.rowsAttempted, 2);
  assert.equal(auditTrail.rowsConfirmedWritten, 1);
  assert.equal(auditTrail.rowsConfirmedAfterReconciliation, 1);
  assert.equal(auditTrail.rowsSkippedAsDuplicates, 1);
  assert.equal(auditTrail.rowsLeftUnresolved, 1);
});

test("buildWriteAuditTrail rejects written rows that are missing operation keys or evidence summaries", () => {
  assert.throws(
    () =>
      buildWriteAuditTrail(
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
          ],
        },
        [{ rowIndex: 0, operationKey: "", status: "written" }],
        1
      ),
    /operation key|evidence summary/
  );
});

test("assertPersistedWriteAuditRecordInvariants rejects complete audits with unresolved rows or missing provider mode", () => {
  assert.throws(
    () =>
      assertPersistedWriteAuditRecordInvariants({
        databaseId: "db_123",
        status: "complete",
        usedExistingDatabase: true,
        resumedFromIndex: 0,
        nextRowIndex: 1,
        message: "Completed write",
        auditTrail: {
          sourceSet: ["https://example.com/a"],
          extractionCounts: {
            searchQueries: 1,
            candidateSources: 1,
            pagesBrowsed: 1,
            rowsExtracted: 1,
          },
          rejectedUrls: [],
          rowsReviewed: 1,
          rowsAttempted: 1,
          rowsConfirmedWritten: 0,
          rowsConfirmedAfterReconciliation: 0,
          rowsSkippedAsDuplicates: 0,
          rowsLeftUnresolved: 1,
          rows: [{ rowIndex: 0, operationKey: "k1", status: "unresolved" }],
        },
      }),
    /providerMode|unresolved/
  );
});

test("assertPersistedWriteAuditRecordInvariants rejects backward resume or non-monotonic nextRowIndex updates", () => {
  const previousRecord: Omit<PersistedWriteAuditRecord, "id" | "createdAt" | "integrity"> = {
    databaseId: "db_123",
    status: "running",
    usedExistingDatabase: true,
    resumedFromIndex: 2,
    nextRowIndex: 3,
    providerMode: "direct-api",
    message: "Running write",
    auditTrail: {
      sourceSet: ["https://example.com/a"],
      extractionCounts: {
        searchQueries: 1,
        candidateSources: 1,
        pagesBrowsed: 1,
        rowsExtracted: 4,
      },
      rejectedUrls: [],
      rowsReviewed: 4,
      rowsAttempted: 1,
      rowsConfirmedWritten: 1,
      rowsConfirmedAfterReconciliation: 0,
      rowsSkippedAsDuplicates: 0,
      rowsLeftUnresolved: 1,
      rows: [
        { rowIndex: 2, operationKey: "k2", status: "written", evidenceSummary: "Evidence for 1 field: Name" },
        { rowIndex: 3, operationKey: "k3", status: "unresolved" },
      ],
    },
  };

  assert.throws(
    () =>
      assertPersistedWriteAuditRecordInvariants(
        {
          ...previousRecord,
          status: "error",
          resumedFromIndex: 1,
          nextRowIndex: 2,
          message: "Paused write",
        },
        previousRecord
      ),
    /resumedFromIndex/
  );

  assert.throws(
    () =>
      assertPersistedWriteAuditRecordInvariants(
        {
          ...previousRecord,
          status: "error",
          providerMode: "direct-api",
          nextRowIndex: 2,
          message: "Paused write",
        },
        previousRecord
      ),
    /nextRowIndex/
  );
});

test("executeWriteJob refuses to persist terminal success when a written row lacks a real evidence summary", async () => {
  process.env.WRITE_AUDIT_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-write-invariants-"));

  const fakeProvider: NotionProvider = {
    async createDatabase() {
      return { databaseId: "11111111-1111-1111-1111-111111111111" };
    },
    async getDatabaseMetadataSupport() {
      return {
        operationKey: true,
        sourceSet: true,
        confidenceScore: true,
        evidenceSummary: true,
      };
    },
    async queryExistingRows() {
      return {
        has() {
          return false;
        },
        remember() {},
      };
    },
    async createPage() {
      return { created: true };
    },
  };
  notionTestOverrides.provider = fakeProvider;

  await assert.rejects(
    executeWriteJob(
      {
        suggestedDbTitle: "Invariant Test",
        summary: "This payload lacks real field evidence.",
        schema: { Name: "title" },
        items: [
          {
            Name: "Alpha",
            __provenance: {
              sourceUrls: ["https://example.com/a"],
              evidenceByField: {},
            },
          },
        ],
      },
      {
        onUpdate() {},
      }
    ),
    /evidence summary/
  );

  const persistedFiles = await readdir(process.env.WRITE_AUDIT_DIR);
  const auditIds = persistedFiles
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""));
  const persistedAudits = await Promise.all(auditIds.map((auditId) => loadWriteAuditRecord(auditId)));
  const sortedAudits = persistedAudits
    .filter((audit): audit is NonNullable<typeof audit> => Boolean(audit))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  assert.equal(sortedAudits.length, 1);
  assert.equal(sortedAudits.at(-1)?.status, "running");
  assert.doesNotMatch(sortedAudits.at(-1)?.message ?? "", /completed|error/i);
});

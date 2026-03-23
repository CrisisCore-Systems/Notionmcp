import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildWriteAuditUrl,
  loadWriteAuditRecord,
  persistWriteAuditRecord,
} from "@/lib/write-audit-store";

const ORIGINAL_ENV = { ...process.env };

test.afterEach(async () => {
  const auditDir = process.env.WRITE_AUDIT_DIR;
  process.env.WRITE_AUDIT_DIR = ORIGINAL_ENV.WRITE_AUDIT_DIR;

  if (auditDir?.startsWith(path.join(os.tmpdir(), "notionmcp-audits-"))) {
    await rm(auditDir, { recursive: true, force: true });
  }
});

test("persistWriteAuditRecord stores and reloads server-side write audits", async () => {
  process.env.WRITE_AUDIT_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-audits-"));

  const persisted = await persistWriteAuditRecord({
    databaseId: "db_123",
    status: "complete",
    usedExistingDatabase: true,
    resumedFromIndex: 2,
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
      rowsAttempted: 1,
      rowsConfirmedWritten: 1,
      rowsSkippedAsDuplicates: 0,
      rowsLeftUnresolved: 0,
      rows: [{ rowIndex: 0, operationKey: "op_1", status: "written" }],
    },
  });

  const loaded = await loadWriteAuditRecord(persisted.id);

  assert.ok(loaded);
  assert.equal(loaded?.id, persisted.id);
  assert.equal(loaded?.databaseId, "db_123");
  assert.equal(loaded?.status, "complete");
  assert.equal(buildWriteAuditUrl(persisted.id), `/api/write-audits/${persisted.id}`);
});

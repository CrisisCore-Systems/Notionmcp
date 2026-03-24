import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
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
  process.env.WRITE_AUDIT_RETENTION_DAYS = ORIGINAL_ENV.WRITE_AUDIT_RETENTION_DAYS;
  process.env.PERSISTED_STATE_ENCRYPTION_KEY = ORIGINAL_ENV.PERSISTED_STATE_ENCRYPTION_KEY;

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
    providerMode: "direct-api",
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
  assert.equal(loaded?.providerMode, "direct-api");
  assert.equal(buildWriteAuditUrl(persisted.id), `/api/write-audits/${persisted.id}`);
});

test("persistWriteAuditRecord expires files beyond the retention window", async () => {
  process.env.WRITE_AUDIT_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-audits-"));
  process.env.WRITE_AUDIT_RETENTION_DAYS = "1";

  const persisted = await persistWriteAuditRecord({
    databaseId: "db_123",
    status: "complete",
    usedExistingDatabase: false,
    resumedFromIndex: 0,
    message: "Expired write audit",
    auditTrail: {
      sourceSet: [],
      extractionCounts: {
        searchQueries: 0,
        candidateSources: 0,
        pagesBrowsed: 0,
        rowsExtracted: 0,
      },
      rejectedUrls: [],
      rowsAttempted: 0,
      rowsConfirmedWritten: 0,
      rowsSkippedAsDuplicates: 0,
      rowsLeftUnresolved: 0,
      rows: [],
    },
  });

  const auditPath = path.join(process.env.WRITE_AUDIT_DIR, `${persisted.id}.json`);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(auditPath, twoDaysAgo, twoDaysAgo);

  await persistWriteAuditRecord({
    databaseId: "db_456",
    status: "complete",
    usedExistingDatabase: true,
    resumedFromIndex: 1,
    message: "Fresh write audit",
    auditTrail: {
      sourceSet: [],
      extractionCounts: {
        searchQueries: 0,
        candidateSources: 0,
        pagesBrowsed: 0,
        rowsExtracted: 0,
      },
      rejectedUrls: [],
      rowsAttempted: 0,
      rowsConfirmedWritten: 0,
      rowsSkippedAsDuplicates: 0,
      rowsLeftUnresolved: 0,
      rows: [],
    },
  });

  assert.equal(await loadWriteAuditRecord(persisted.id), null);
});

test("persistWriteAuditRecord encrypts persisted state when configured", async () => {
  process.env.WRITE_AUDIT_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-audits-"));
  process.env.PERSISTED_STATE_ENCRYPTION_KEY = "operator-secret";

  const persisted = await persistWriteAuditRecord({
    databaseId: "db_123",
    status: "complete",
    usedExistingDatabase: true,
    resumedFromIndex: 2,
    providerMode: "direct-api",
    message: "Completed encrypted write",
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

  const rawFile = await readFile(path.join(process.env.WRITE_AUDIT_DIR, `${persisted.id}.json`), "utf8");
  const loaded = await loadWriteAuditRecord(persisted.id);

  assert.match(rawFile, /notionmcp-encrypted-state\/v1/);
  assert.doesNotMatch(rawFile, /Completed encrypted write/);
  assert.equal(loaded?.message, "Completed encrypted write");
});

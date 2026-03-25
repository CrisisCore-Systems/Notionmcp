import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildWriteAuditUrl,
  loadWriteAuditRecord,
  persistWriteAuditRecord,
  saveWriteAuditRecord,
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
      rowsReviewed: 1,
      rowsAttempted: 1,
      rowsConfirmedWritten: 1,
      rowsConfirmedAfterReconciliation: 0,
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
  assert.ok(loaded?.integrity?.recordHash);
  assert.ok(loaded?.integrity?.mac);
  assert.ok(loaded?.integrity?.keyId);
  assert.ok(loaded?.integrity?.signedAt);
  assert.ok(loaded?.integrity?.sourceSetHash);
  assert.ok(loaded?.integrity?.rowOutcomesHash);
  assert.ok(loaded?.integrity?.auditPayloadHash);
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
        rowsReviewed: 0,
        rowsAttempted: 0,
        rowsConfirmedWritten: 0,
        rowsConfirmedAfterReconciliation: 0,
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
        rowsReviewed: 0,
        rowsAttempted: 0,
        rowsConfirmedWritten: 0,
        rowsConfirmedAfterReconciliation: 0,
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
        rowsReviewed: 1,
        rowsAttempted: 1,
        rowsConfirmedWritten: 1,
        rowsConfirmedAfterReconciliation: 0,
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

test("persistWriteAuditRecord detects tampering with persisted audit artifacts", async () => {
  process.env.WRITE_AUDIT_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-audits-"));

  const persisted = await persistWriteAuditRecord({
    databaseId: "db_123",
    status: "complete",
    usedExistingDatabase: true,
    resumedFromIndex: 0,
    providerMode: "direct-api",
    message: "Integrity-sensitive audit",
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
      rowsConfirmedWritten: 1,
      rowsConfirmedAfterReconciliation: 0,
      rowsSkippedAsDuplicates: 0,
      rowsLeftUnresolved: 0,
      rows: [{ rowIndex: 0, operationKey: "op_1", status: "written" }],
    },
  });
  const auditPath = path.join(process.env.WRITE_AUDIT_DIR, `${persisted.id}.json`);
  const parsed = JSON.parse(await readFile(auditPath, "utf8")) as
    | {
        format: string;
        ciphertext: string;
      }
    | {
        integrity: {
          mac: string;
        };
      };

  if ("format" in parsed) {
    parsed.ciphertext = `A${parsed.ciphertext.slice(1)}`;
  } else {
    parsed.integrity.mac = `${"0".repeat(63)}1`;
  }

  await writeFile(auditPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await assert.rejects(async () => await loadWriteAuditRecord(persisted.id));
});

test("saveWriteAuditRecord updates an existing persisted audit artifact", async () => {
  process.env.WRITE_AUDIT_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-audits-"));

  const persisted = await persistWriteAuditRecord({
    databaseId: "db_123",
    status: "running",
    usedExistingDatabase: false,
    resumedFromIndex: 0,
    nextRowIndex: 0,
    message: "Running write audit",
    auditTrail: {
      sourceSet: [],
      extractionCounts: {
        searchQueries: 0,
        candidateSources: 0,
        pagesBrowsed: 0,
        rowsExtracted: 1,
      },
      rejectedUrls: [],
      rowsReviewed: 1,
      rowsAttempted: 0,
      rowsConfirmedWritten: 0,
      rowsConfirmedAfterReconciliation: 0,
      rowsSkippedAsDuplicates: 0,
      rowsLeftUnresolved: 1,
      rows: [{ rowIndex: 0, operationKey: "op_1", status: "unresolved" }],
    },
  });

  await saveWriteAuditRecord({
    ...persisted,
    status: "complete",
    nextRowIndex: 1,
    message: "Completed write audit",
    auditTrail: {
      ...persisted.auditTrail,
      rowsAttempted: 1,
      rowsConfirmedWritten: 1,
      rowsLeftUnresolved: 0,
      rows: [{ rowIndex: 0, operationKey: "op_1", status: "written" }],
    },
  });

  const loaded = await loadWriteAuditRecord(persisted.id);

  assert.ok(loaded);
  assert.equal(loaded?.id, persisted.id);
  assert.equal(loaded?.status, "complete");
  assert.equal(loaded?.nextRowIndex, 1);
  assert.equal(loaded?.message, "Completed write audit");
  assert.equal(loaded?.integrity?.previousHash, persisted.integrity?.recordHash);
});

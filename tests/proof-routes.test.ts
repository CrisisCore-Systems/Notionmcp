import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as getJobVerification } from "@/app/api/jobs/[jobId]/route";
import { GET as getWriteAuditVerification } from "@/app/api/write-audits/[auditId]/route";
import { createJob } from "@/lib/job-store";
import { persistWriteAuditRecord } from "@/lib/write-audit-store";

const ORIGINAL_ENV = { ...process.env };

function createGetRequest(url: string) {
  const headers = new Headers({
    host: new URL(url).host,
  });

  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-proof-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-proof-audits-")),
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("durable job verification route returns persisted job state plus verification contract metadata", async () => {
  const job = await createJob("research", { prompt: "Find CRM competitors" });
  const response = await getJobVerification(createGetRequest(`http://localhost:3000/api/jobs/${job.id}`), {
    params: Promise.resolve({ jobId: job.id }),
  });
  const payload = (await response.json()) as {
    id: string;
    integrity: {
      recordHash: string;
      mac: string;
      keyId: string;
      signedAt: string;
    };
    verificationContract: {
      kind: string;
      verificationArtifact: string;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "durable-job-verification");
  assert.equal(payload.id, job.id);
  assert.ok(payload.integrity.recordHash);
  assert.ok(payload.integrity.mac);
  assert.ok(payload.integrity.keyId);
  assert.ok(payload.integrity.signedAt);
  assert.equal(payload.verificationContract.kind, "durable-job-verification");
  assert.equal(payload.verificationContract.verificationArtifact, "durable job state");
});

test("write audit verification route returns persisted audit state plus verification contract metadata", async () => {
  const audit = await persistWriteAuditRecord({
    status: "complete",
    usedExistingDatabase: false,
    resumedFromIndex: 0,
    message: "Audit ready",
    providerMode: "direct-api",
    auditTrail: {
      sourceSet: ["https://example.com"],
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
      rows: [{ rowIndex: 0, operationKey: "op-1", status: "written" }],
    },
  });
  const response = await getWriteAuditVerification(
    createGetRequest(`http://localhost:3000/api/write-audits/${audit.id}`),
    {
      params: Promise.resolve({ auditId: audit.id }),
    }
  );
  const payload = (await response.json()) as {
    id: string;
    integrity: {
      recordHash: string;
      mac: string;
      keyId: string;
      signedAt: string;
      sourceSetHash: string;
      rowOutcomesHash: string;
      auditPayloadHash: string;
    };
    verificationContract: {
      kind: string;
      verificationArtifact: string;
      providerArchitecture: {
        mode: string;
      };
    };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "write-audit-verification");
  assert.equal(response.headers.get("x-notionmcp-provider-mode"), "local-mcp");
  assert.equal(payload.id, audit.id);
  assert.ok(payload.integrity.recordHash);
  assert.ok(payload.integrity.mac);
  assert.ok(payload.integrity.keyId);
  assert.ok(payload.integrity.signedAt);
  assert.ok(payload.integrity.sourceSetHash);
  assert.ok(payload.integrity.rowOutcomesHash);
  assert.ok(payload.integrity.auditPayloadHash);
  assert.equal(payload.verificationContract.kind, "write-audit-verification");
  assert.equal(payload.verificationContract.verificationArtifact, "write audit trail");
  assert.equal(payload.verificationContract.providerArchitecture.mode, "local-mcp");
});

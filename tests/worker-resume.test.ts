import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET as getWriteAuditVerification } from "@/app/api/write-audits/[auditId]/route";
import { POST as postWrite } from "@/app/api/write/route";
import { createDurableJob } from "@/lib/job-runner";
import { loadJobRecord, updateJobRecord } from "@/lib/job-store";
import { notionTestOverrides, type NotionProvider } from "@/lib/notion";
import { RESEARCH_RUN_METADATA_KEY, type ResearchResult } from "@/lib/research-result";
import { buildRowWriteMetadata } from "@/lib/write-audit";
import { collectSseResponse, createGetRequest, createPostRequest } from "@/tests/support/e2e";

const ORIGINAL_ENV = { ...process.env };

function buildWritePayload(): ResearchResult {
  return {
    suggestedDbTitle: "Resume Test",
    summary: "Two supported rows allow resume semantics to be verified.",
    schema: {
      Name: "title",
      URL: "url",
      Description: "rich_text",
    },
    items: [
      {
        Name: "Alpha",
        URL: "https://alpha.example.com",
        Description: "Alpha row",
        __provenance: {
          sourceUrls: ["https://alpha.example.com", "https://alpha.example.com/about"],
          evidenceByField: {
            Name: ["[alpha-f1] Alpha", "[alpha-f2] Alpha product"],
            Description: ["[alpha-f3] Alpha row", "[alpha-f4] Alpha company"],
          },
        },
      },
      {
        Name: "Beta",
        URL: "https://beta.example.com",
        Description: "Beta row",
        __provenance: {
          sourceUrls: ["https://beta.example.com", "https://beta.example.com/about"],
          evidenceByField: {
            Name: ["[beta-f1] Beta", "[beta-f2] Beta product"],
            Description: ["[beta-f3] Beta row", "[beta-f4] Beta company"],
          },
        },
      },
    ],
    [RESEARCH_RUN_METADATA_KEY]: {
      sourceSet: [
        "https://alpha.example.com",
        "https://alpha.example.com/about",
        "https://beta.example.com",
        "https://beta.example.com/about",
      ],
      extractionCounts: {
        searchQueries: 2,
        candidateSources: 4,
        pagesBrowsed: 4,
        rowsExtracted: 2,
      },
      rejectedUrls: [],
    },
  };
}

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-worker-resume-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-worker-resume-audits-")),
    NOTIONMCP_HOST_DURABILITY: "inline-only",
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };
  delete notionTestOverrides.provider;

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("worker crash and resume reconnects from checkpoint without duplicate append", async () => {
  const payload = buildWritePayload();
  const operationKeys = payload.items.map((item) => buildRowWriteMetadata(item, payload.schema).operationKey);
  const committedOperationKeys = new Set<string>([operationKeys[0] ?? ""]);
  const writes: string[] = [];
  const fakeProvider: NotionProvider = {
    async createDatabase() {
      throw new Error("existing database should be reused");
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
        has(_data, operationKey) {
          return operationKey ? committedOperationKeys.has(operationKey) : false;
        },
        remember(_data, operationKey) {
          if (operationKey) {
            committedOperationKeys.add(operationKey);
          }
        },
      };
    },
    async createPage(input) {
      const operationKey = input.writeMetadata?.operationKey ?? "";
      writes.push(operationKey);
      input.duplicateTracker?.remember(input.data, operationKey);
      return { created: true };
    },
  };
  notionTestOverrides.provider = fakeProvider;

  const job = await createDurableJob("write", {
    ...payload,
    targetDatabaseId: "11111111-1111-1111-1111-111111111111",
  });
  await updateJobRecord(job.id, (record) => ({
    ...record,
    status: "running",
    worker: {
      pid: 4321,
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    },
    checkpoint: {
      phase: "writing",
      databaseId: "11111111-1111-1111-1111-111111111111",
      nextRowIndex: 1,
      resumedFromIndex: 0,
    },
  }));

  const response = await postWrite(
    createPostRequest("http://localhost:3000/api/write", {
      jobId: job.id,
      afterEventId: 0,
    })
  );
  const stream = await collectSseResponse(response);
  const completed = stream.complete as { auditId?: string; databaseId?: string } | undefined;

  assert.equal(response.status, 200);
  assert.equal(stream.error, undefined);
  assert.equal(completed?.databaseId, "11111111-1111-1111-1111-111111111111");
  assert.ok(completed?.auditId);
  assert.ok(stream.updates.some((message) => /Resuming Notion write from row 2 of 2/.test(message)));
  assert.ok(stream.updates.some((message) => /Added row 2 of 2/.test(message)));
  assert.deepEqual(writes, [operationKeys[1]]);

  const record = await loadJobRecord(job.id);
  assert.equal(record?.status, "complete");
  assert.equal(record?.checkpoint?.databaseId, "11111111-1111-1111-1111-111111111111");
  assert.equal(record?.checkpoint?.nextRowIndex, 2);

  const auditResponse = await getWriteAuditVerification(
    createGetRequest(`http://localhost:3000/api/write-audits/${completed?.auditId ?? ""}`),
    { params: Promise.resolve({ auditId: completed?.auditId ?? "" }) }
  );
  const auditProof = (await auditResponse.json()) as {
    resumedFromIndex: number;
    auditTrail: {
      rowsAttempted: number;
      rowsConfirmedWritten: number;
      rows: Array<{ rowIndex: number; status: string }>;
    };
  };

  assert.equal(auditProof.resumedFromIndex, 1);
  assert.equal(auditProof.auditTrail.rowsAttempted, 1);
  assert.equal(auditProof.auditTrail.rowsConfirmedWritten, 1);
  assert.deepEqual(
    auditProof.auditTrail.rows.map((row) => ({ rowIndex: row.rowIndex, status: row.status })),
    [{ rowIndex: 1, status: "written" }]
  );
});

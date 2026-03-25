import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET as getJobVerification } from "@/app/api/jobs/[jobId]/route";
import { GET as getWriteAuditVerification } from "@/app/api/write-audits/[auditId]/route";
import { POST as postWrite } from "@/app/api/write/route";
import { notionTestOverrides, type NotionProvider } from "@/lib/notion";
import { RESEARCH_RUN_METADATA_KEY, type ResearchResult } from "@/lib/research-result";
import { buildRowWriteMetadata } from "@/lib/write-audit";
import { collectSseResponse, createGetRequest, createPostRequest } from "@/tests/support/e2e";

const ORIGINAL_ENV = { ...process.env };

function buildPayload(): ResearchResult {
  return {
    suggestedDbTitle: "Chaos Test",
    summary: "A write failure after a likely commit should reconcile and resume cleanly.",
    schema: {
      Name: "title",
      URL: "url",
      Description: "rich_text",
    },
    items: [
      {
        Name: "Beta Suite",
        URL: "https://beta.example.com/pricing",
        Description: "Public pricing page describing Beta Suite's team plan.",
        __provenance: {
          sourceUrls: ["https://beta.example.com/pricing", "https://news.example.com/beta-suite-review"],
          evidenceByField: {
            Name: ["[b1] Beta Suite", "[b2] pricing page"],
            Description: ["[b3] team plan", "[b4] public pricing page"],
          },
        },
      },
      {
        Name: "Gamma Cloud",
        URL: "https://gamma.example.com/pricing",
        Description: "Pricing page confirms Gamma Cloud offers a self-serve starter tier.",
        __provenance: {
          sourceUrls: ["https://gamma.example.com/pricing", "https://analysis.example.com/gamma-cloud"],
          evidenceByField: {
            Name: ["[g1] Gamma Cloud", "[g2] pricing page"],
            Description: ["[g3] self-serve starter tier", "[g4] pricing page confirms"],
          },
        },
      },
    ],
    [RESEARCH_RUN_METADATA_KEY]: {
      sourceSet: [
        "https://beta.example.com/pricing",
        "https://news.example.com/beta-suite-review",
        "https://gamma.example.com/pricing",
        "https://analysis.example.com/gamma-cloud",
      ],
      extractionCounts: {
        searchQueries: 4,
        candidateSources: 8,
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
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-reconciliation-chaos-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-reconciliation-chaos-audits-")),
    NOTIONMCP_HOST_DURABILITY: "inline-only",
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };
  delete notionTestOverrides.provider;

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("ambiguous write success reconciles the likely commit and resumes the next unresolved row correctly", async () => {
  const payload = buildPayload();
  const operationKeys = payload.items.map((item) => buildRowWriteMetadata(item, payload.schema).operationKey);
  const committedOperationKeys = new Set<string>();
  const writes: string[] = [];
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

      if (operationKey === operationKeys[0]) {
        committedOperationKeys.add(operationKey);
        throw new Error("HTTP 429 rate limit from Notion after the row commit");
      }

      input.duplicateTracker?.remember(input.data, operationKey);
      committedOperationKeys.add(operationKey);
      return { created: true };
    },
  };
  notionTestOverrides.provider = fakeProvider;

  const failedResponse = await postWrite(createPostRequest("http://localhost:3000/api/write", payload));
  const failedStream = await collectSseResponse(failedResponse);
  const failedJobId =
    ((failedStream.events.find((event) => event.name === "job")?.data as { jobId?: string } | undefined)?.jobId ?? "").trim();

  assert.match(failedJobId, /^[0-9a-fA-F-]{36}$/);
  assert.ok(failedStream.error);
  assert.match(failedStream.error?.message ?? "", /Reconciliation verified the last ambiguous row before pausing/);

  const failedProofResponse = await getJobVerification(
    createGetRequest(`http://localhost:3000/api/jobs/${failedJobId}`),
    { params: Promise.resolve({ jobId: failedJobId }) }
  );
  const failedProof = (await failedProofResponse.json()) as {
    status: string;
    checkpoint?: { databaseId?: string; nextRowIndex?: number; phase?: string };
    error?: {
      auditId?: string;
      nextRowIndex?: number;
      auditTrail?: { rows: Array<{ status: string }> };
    };
  };

  assert.equal(failedProof.status, "error");
  assert.equal(failedProof.checkpoint?.phase, "error");
  assert.equal(failedProof.checkpoint?.nextRowIndex, 1);
  assert.deepEqual(failedProof.error?.auditTrail?.rows.map((row) => row.status), [
    "written-after-reconciliation",
    "unresolved",
  ]);

  const failedAuditResponse = await getWriteAuditVerification(
    createGetRequest(`http://localhost:3000/api/write-audits/${failedProof.error?.auditId ?? ""}`),
    { params: Promise.resolve({ auditId: failedProof.error?.auditId ?? "" }) }
  );
  const failedAudit = (await failedAuditResponse.json()) as {
    nextRowIndex?: number;
    auditTrail: {
      rowsConfirmedAfterReconciliation: number;
      rowsLeftUnresolved: number;
      rows: Array<{ status: string }>;
    };
  };

  assert.equal(failedAudit.nextRowIndex, 1);
  assert.equal(failedAudit.auditTrail.rowsConfirmedAfterReconciliation, 1);
  assert.equal(failedAudit.auditTrail.rowsLeftUnresolved, 1);
  assert.deepEqual(failedAudit.auditTrail.rows.map((row) => row.status), [
    "written-after-reconciliation",
    "unresolved",
  ]);

  const resumedResponse = await postWrite(
    createPostRequest("http://localhost:3000/api/write", {
      ...payload,
      targetDatabaseId: failedProof.checkpoint?.databaseId,
      resumeFromIndex: failedProof.checkpoint?.nextRowIndex,
    })
  );
  const resumedStream = await collectSseResponse(resumedResponse);
  const resumedComplete = resumedStream.complete as { auditId?: string; databaseId?: string } | undefined;

  assert.equal(resumedStream.error, undefined);
  assert.equal(resumedComplete?.databaseId, "11111111-1111-1111-1111-111111111111");
  assert.ok(resumedComplete?.auditId);

  const resumedAuditResponse = await getWriteAuditVerification(
    createGetRequest(`http://localhost:3000/api/write-audits/${resumedComplete?.auditId ?? ""}`),
    { params: Promise.resolve({ auditId: resumedComplete?.auditId ?? "" }) }
  );
  const resumedAudit = (await resumedAuditResponse.json()) as {
    resumedFromIndex: number;
    auditTrail: {
      rowsAttempted: number;
      rowsConfirmedWritten: number;
      rowsLeftUnresolved: number;
      rows: Array<{ rowIndex: number; status: string }>;
    };
  };

  assert.equal(resumedAudit.resumedFromIndex, 1);
  assert.equal(resumedAudit.auditTrail.rowsAttempted, 1);
  assert.equal(resumedAudit.auditTrail.rowsConfirmedWritten, 1);
  assert.equal(resumedAudit.auditTrail.rowsLeftUnresolved, 0);
  assert.deepEqual(
    resumedAudit.auditTrail.rows.map((row) => ({ rowIndex: row.rowIndex, status: row.status })),
    [{ rowIndex: 1, status: "written" }]
  );
  assert.ok(writes.filter((operationKey) => operationKey === operationKeys[0]).length >= 3);
  assert.ok(writes.includes(operationKeys[1] ?? ""));
});

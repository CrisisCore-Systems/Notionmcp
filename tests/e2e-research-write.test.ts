import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { GET as getJobVerification } from "@/app/api/jobs/[jobId]/route";
import { POST as postResearch } from "@/app/api/research/route";
import { GET as getWriteAuditVerification } from "@/app/api/write-audits/[auditId]/route";
import { POST as postWrite } from "@/app/api/write/route";
import { jobRunnerTestOverrides } from "@/lib/job-runner";
import { notionTestOverrides, type NotionProvider } from "@/lib/notion";
import { RESEARCH_RUN_METADATA_KEY, type ResearchResult } from "@/lib/research-result";
import { collectSseResponse, createGetRequest, createPostRequest } from "@/tests/support/e2e";

const ORIGINAL_ENV = { ...process.env };

function buildResearchResult(name = "Beta Suite"): ResearchResult {
  return {
    suggestedDbTitle: "Acme Alternatives",
    summary: "Reviewed public sources identify one supported alternative with public pricing.",
    schema: {
      Name: "title",
      URL: "url",
      Description: "rich_text",
    },
    items: [
      {
        Name: name,
        URL: "https://beta.example.com/pricing",
        Description: "Public pricing page describing the supported alternative.",
        __provenance: {
          sourceUrls: [
            "https://beta.example.com/pricing",
            "https://news.example.com/beta-suite-review",
          ],
          evidenceByField: {
            Name: ["[doc-f1] Beta Suite pricing", "[news-f2] Beta Suite review"],
            Description: [
              "[doc-f3] Public pricing page describing the supported alternative.",
              "[news-f4] Review coverage corroborates the public pricing page.",
            ],
          },
        },
      },
    ],
    [RESEARCH_RUN_METADATA_KEY]: {
      sourceSet: [
        "https://beta.example.com/pricing",
        "https://news.example.com/beta-suite-review",
      ],
      extractionCounts: {
        searchQueries: 2,
        candidateSources: 4,
        pagesBrowsed: 2,
        rowsExtracted: 1,
      },
      rejectedUrls: ["https://community.example.com/thread"],
      search: {
        configuredProviders: ["duckduckgo"],
        usedProviders: ["duckduckgo"],
        degraded: true,
        mode: "deep",
        profile: {
          plannerModel: "gemini-2.5-pro",
          verifierModel: "gemini-2.5-pro",
          maxReconciliationAttempts: 3,
          maxPlannedQueries: 8,
          maxEvidenceDocuments: 16,
          minUniqueDomains: 5,
          minSourceClasses: 4,
          minIndependentSourcesPerField: 2,
          minCrossSourceAgreement: 1,
        },
        uniqueDomains: ["beta.example.com", "news.example.com"],
        sourceClasses: ["editorial", "official"],
        sourceQuality: {
          averageScore: 84.5,
          primarySourceCount: 1,
          officialSourceCount: 1,
          dateAvailableSourceCount: 1,
          authorAvailableSourceCount: 0,
          strongestSourceUrls: ["https://beta.example.com/pricing"],
        },
        freshness: {
          timeSensitivePrompt: false,
          sourceCountWithDates: 1,
        },
      },
    },
  };
}

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-e2e-research-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-e2e-research-audits-")),
    NOTIONMCP_HOST_DURABILITY: "inline-only",
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };
  delete jobRunnerTestOverrides.runResearchAgent;
  delete notionTestOverrides.provider;

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("research happy path creates a job, streams SSE, finishes, and persists a verification artifact", async () => {
  const prompt = "Find Acme alternatives with public pricing pages";
  const result = buildResearchResult();

  jobRunnerTestOverrides.runResearchAgent = async (inputPrompt, onUpdate, options) => {
    assert.equal(inputPrompt, prompt);
    assert.equal(options?.researchMode, "deep");

    await onUpdate("🧭 Planning higher-budget reviewed deep lane...", { phase: "planning" });
    await delay(50);
    await onUpdate("🧪 Verifying candidate rows against normalized evidence...", {
      phase: "verifying",
      pagesBrowsed: 2,
      evidenceDocumentCount: 2,
    });

    return result;
  };

  const response = await postResearch(
    createPostRequest("http://localhost:3000/api/research", {
      prompt,
      researchMode: "deep",
    })
  );
  const stream = await collectSseResponse(response);
  const jobId = ((stream.events.find((event) => event.name === "job")?.data as { jobId?: string } | undefined)?.jobId ?? "").trim();
  const completed = stream.complete as ResearchResult | undefined;

  assert.equal(response.status, 200);
  assert.match(jobId, /^[0-9a-fA-F-]{36}$/);
  assert.equal(stream.error, undefined);
  assert.deepEqual(stream.updates, [
    "🧭 Planning higher-budget reviewed deep lane...",
    "🧪 Verifying candidate rows against normalized evidence...",
  ]);
  assert.equal(completed?.suggestedDbTitle, result.suggestedDbTitle);

  const proofResponse = await getJobVerification(
    createGetRequest(`http://localhost:3000/api/jobs/${jobId}`),
    { params: Promise.resolve({ jobId }) }
  );
  const proof = (await proofResponse.json()) as {
    status: string;
    verificationContract: { kind: string };
    checkpoint?: { phase?: string };
    result?: ResearchResult;
  };

  assert.equal(proofResponse.status, 200);
  assert.equal(proof.status, "complete");
  assert.equal(proof.verificationContract.kind, "durable-job-verification");
  assert.equal(proof.checkpoint?.phase, "complete");
  assert.equal(proof.result?.items[0]?.Name, "Beta Suite");
});

test("write happy path accepts a reviewed payload, creates a write job, and persists an audit artifact", async () => {
  const payload = buildResearchResult();
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
      const seen = new Set<string>();

      return {
        has(_data, operationKey) {
          return operationKey ? seen.has(operationKey) : false;
        },
        remember(_data, operationKey) {
          if (operationKey) {
            seen.add(operationKey);
          }
        },
      };
    },
    async createPage(input) {
      writes.push(input.writeMetadata?.operationKey ?? "");
      input.duplicateTracker?.remember(input.data, input.writeMetadata?.operationKey);
      return { created: true };
    },
  };
  notionTestOverrides.provider = fakeProvider;

  const response = await postWrite(createPostRequest("http://localhost:3000/api/write", payload));
  const stream = await collectSseResponse(response);
  const completed = stream.complete as { auditId?: string; databaseId?: string } | undefined;

  assert.equal(response.status, 200);
  assert.equal(stream.error, undefined);
  assert.equal(completed?.databaseId, "11111111-1111-1111-1111-111111111111");
  assert.ok(completed?.auditId);
  assert.equal(writes.length, 1);

  const auditResponse = await getWriteAuditVerification(
    createGetRequest(`http://localhost:3000/api/write-audits/${completed?.auditId ?? ""}`),
    { params: Promise.resolve({ auditId: completed?.auditId ?? "" }) }
  );
  const auditProof = (await auditResponse.json()) as {
    status: string;
    verificationContract: { kind: string };
    auditTrail: {
      sourceSet: string[];
      rowsConfirmedWritten: number;
      rows: Array<{ status: string }>;
    };
  };

  assert.equal(auditResponse.status, 200);
  assert.equal(auditProof.status, "complete");
  assert.equal(auditProof.verificationContract.kind, "write-audit-verification");
  assert.equal(auditProof.auditTrail.rowsConfirmedWritten, 1);
  assert.deepEqual(auditProof.auditTrail.sourceSet, payload[RESEARCH_RUN_METADATA_KEY]?.sourceSet);
  assert.deepEqual(auditProof.auditTrail.rows.map((row) => row.status), ["written"]);
});

test("remote-private-host startup refusal works for missing encryption, missing token, and inline-only durability", async () => {
  const payload = buildResearchResult();

  process.env.NOTIONMCP_DEPLOYMENT_MODE = "remote-private-host";
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  process.env.APP_ACCESS_TOKEN = "secret-token";
  delete process.env.NOTIONMCP_HOST_DURABILITY;
  delete process.env.PERSISTED_STATE_ENCRYPTION_KEY;

  await assert.rejects(
    postResearch(
      createPostRequest("http://localhost:3000/api/research", {
        prompt: "Find supported alternatives",
      })
    ),
    /PERSISTED_STATE_ENCRYPTION_KEY/
  );

  process.env.PERSISTED_STATE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
  delete process.env.APP_ACCESS_TOKEN;

  await assert.rejects(
    postWrite(createPostRequest("http://localhost:3000/api/write", payload)),
    /APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN/
  );

  process.env.APP_ACCESS_TOKEN = "secret-token";
  process.env.NOTIONMCP_HOST_DURABILITY = "inline-only";

  await assert.rejects(
    postResearch(
      createPostRequest("http://localhost:3000/api/research", {
        prompt: "Find supported alternatives",
      })
    ),
    /inline-only/
  );
});

test("adversarial content path rejects unsupported rows and does not invent them into the artifact", async () => {
  const prompt = "Find reviewed alternatives without inventing unsupported vendors";
  const result = buildResearchResult("Trusted Suite");

  jobRunnerTestOverrides.runResearchAgent = async (_inputPrompt, onUpdate) => {
    await onUpdate('🚫 Rejected unsupported row "Shadow Product": contradictory evidence across poisoned source pages.', {
      phase: "verifying",
      evidenceDocumentCount: 2,
      pagesBrowsed: 2,
    });

    return result;
  };

  const response = await postResearch(
    createPostRequest("http://localhost:3000/api/research", {
      prompt,
      researchMode: "deep",
    })
  );
  const stream = await collectSseResponse(response);
  const jobId = ((stream.events.find((event) => event.name === "job")?.data as { jobId?: string } | undefined)?.jobId ?? "").trim();
  const completed = stream.complete as ResearchResult | undefined;

  assert.equal(stream.error, undefined);
  assert.ok(stream.updates.some((message) => /Rejected unsupported row "Shadow Product"/.test(message)));
  assert.deepEqual(completed?.items.map((item) => item.Name), ["Trusted Suite"]);

  const proofResponse = await getJobVerification(
    createGetRequest(`http://localhost:3000/api/jobs/${jobId}`),
    { params: Promise.resolve({ jobId }) }
  );
  const proof = (await proofResponse.json()) as {
    result?: ResearchResult;
  };

  assert.deepEqual(proof.result?.items.map((item) => item.Name), ["Trusted Suite"]);
  assert.equal(proof.result?.items.some((item) => item.Name === "Shadow Product"), false);
});

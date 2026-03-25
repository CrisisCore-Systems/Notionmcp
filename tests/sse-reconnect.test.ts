import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { GET as getJobVerification } from "@/app/api/jobs/[jobId]/route";
import { POST as postResearch } from "@/app/api/research/route";
import { jobRunnerTestOverrides } from "@/lib/job-runner";
import { RESEARCH_RUN_METADATA_KEY, type ResearchResult } from "@/lib/research-result";
import {
  collectSseResponse,
  createGetRequest,
  createPostRequest,
  openSseUntil,
} from "@/tests/support/e2e";

const ORIGINAL_ENV = { ...process.env };

function buildResearchResult(): ResearchResult {
  return {
    suggestedDbTitle: "Reconnect Test",
    summary: "Reconnect should replay only missed events and preserve final state.",
    schema: {
      Name: "title",
      URL: "url",
      Description: "rich_text",
    },
    items: [
      {
        Name: "Reconnect Suite",
        URL: "https://reconnect.example.com",
        Description: "Reconnect-safe reviewed row",
        __provenance: {
          sourceUrls: ["https://reconnect.example.com", "https://news.example.com/reconnect-suite"],
          evidenceByField: {
            Name: ["[r1] Reconnect Suite", "[r2] reviewed row"],
            Description: ["[r3] Reconnect-safe reviewed row", "[r4] corroborated row"],
          },
        },
      },
    ],
    [RESEARCH_RUN_METADATA_KEY]: {
      sourceSet: ["https://reconnect.example.com", "https://news.example.com/reconnect-suite"],
      extractionCounts: {
        searchQueries: 3,
        candidateSources: 4,
        pagesBrowsed: 2,
        rowsExtracted: 1,
      },
      rejectedUrls: [],
    },
  };
}

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-sse-reconnect-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-sse-reconnect-audits-")),
    NOTIONMCP_HOST_DURABILITY: "inline-only",
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };
  delete jobRunnerTestOverrides.runResearchAgent;

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("SSE disconnect reconnects with afterEventId, replays only missed events, and preserves final state", async () => {
  const prompt = "Reconnect proof for research streaming";
  const result = buildResearchResult();
  const expectedUpdates = [
    "🧭 Planning search strategy...",
    "🔍 Searching: \"Reconnect proof for research streaming\"",
    "🧪 Verifying candidate rows against normalized evidence...",
  ];

  jobRunnerTestOverrides.runResearchAgent = async (_prompt, onUpdate) => {
    await onUpdate(expectedUpdates[0], { phase: "planning" });
    await delay(350);
    await onUpdate(expectedUpdates[1], { phase: "extracting" });
    await delay(350);
    await onUpdate(expectedUpdates[2], { phase: "verifying", pagesBrowsed: 2, evidenceDocumentCount: 2 });
    return result;
  };

  const response = await postResearch(
    createPostRequest("http://localhost:3000/api/research", {
      prompt,
      researchMode: "fast",
    })
  );
  const initial = await openSseUntil(response, ({ updates, jobId }) => updates.length >= 2 && Boolean(jobId));

  assert.match(initial.jobId, /^[0-9a-fA-F-]{36}$/);
  assert.deepEqual(initial.updates, expectedUpdates.slice(0, 2));

  await delay(500);

  const resumedResponse = await postResearch(
    createPostRequest("http://localhost:3000/api/research", {
      jobId: initial.jobId,
      afterEventId: initial.afterEventId,
    })
  );
  const resumed = await collectSseResponse(resumedResponse);
  const completed = resumed.complete as ResearchResult | undefined;

  assert.equal(resumed.error, undefined);
  assert.deepEqual(resumed.updates, [expectedUpdates[2]]);
  assert.equal(completed?.summary, result.summary);

  const proofResponse = await getJobVerification(
    createGetRequest(`http://localhost:3000/api/jobs/${initial.jobId}`),
    { params: Promise.resolve({ jobId: initial.jobId }) }
  );
  const proof = (await proofResponse.json()) as {
    status: string;
    checkpoint?: {
      phase?: string;
      pagesBrowsed?: number;
      evidenceDocumentCount?: number;
    };
    result?: ResearchResult;
  };

  assert.equal(proof.status, "complete");
  assert.equal(proof.checkpoint?.phase, "complete");
  assert.equal(proof.checkpoint?.pagesBrowsed, 2);
  assert.equal(proof.checkpoint?.evidenceDocumentCount, 2);
  assert.equal(proof.result?.items[0]?.Name, "Reconnect Suite");
  assert.deepEqual([...initial.updates, ...resumed.updates], expectedUpdates);
});

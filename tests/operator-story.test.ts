import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { consumeSSEChunk, createSSEParserState, type SSEParserState } from "@/app/components/chat/stream";
import { GET as getJobProof } from "@/app/api/jobs/[jobId]/route";
import { POST as postResearch } from "@/app/api/research/route";
import { GET as getWriteAuditProof } from "@/app/api/write-audits/[auditId]/route";
import { POST as postWrite } from "@/app/api/write/route";
import { jobRunnerTestOverrides } from "@/lib/job-runner";
import { notionTestOverrides, type NotionProvider } from "@/lib/notion";
import { RESEARCH_RUN_METADATA_KEY, type ResearchResult } from "@/lib/research-result";

const ORIGINAL_ENV = { ...process.env };

function createPostRequest(url: string, body: unknown) {
  const headers = new Headers({
    "content-type": "application/json",
    host: new URL(url).host,
  });

  return new NextRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function createGetRequest(url: string) {
  const headers = new Headers({
    host: new URL(url).host,
  });

  return new NextRequest(url, {
    method: "GET",
    headers,
  });
}

function consumeAllSseMessages(
  state: SSEParserState,
  chunk: string,
  updates: string[]
): {
  state: SSEParserState;
  parsed: Array<ReturnType<typeof consumeSSEChunk>>;
} {
  const parsed: Array<ReturnType<typeof consumeSSEChunk>> = [];
  let nextState = state;
  let nextChunk = chunk;

  while (true) {
    const result = consumeSSEChunk(nextState, nextChunk, (message) => {
      updates.push(message);
    });
    nextState = result.state;
    nextChunk = "";

    if (result.event || result.complete !== undefined || result.continue || result.error) {
      parsed.push(result);
      continue;
    }

    return { state: nextState, parsed };
  }
}

async function collectSseResponse(response: Response): Promise<{
  updates: string[];
  events: Array<{ name: string; data: unknown }>;
  complete?: unknown;
  reconnect?: { jobId: string; afterEventId: number };
}> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const updates: string[] = [];
  const events: Array<{ name: string; data: unknown }> = [];
  let complete: unknown;
  let reconnect: { jobId: string; afterEventId: number } | undefined;
  let state = createSSEParserState();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      return { updates, events, complete, reconnect };
    }

    const consumed = consumeAllSseMessages(state, decoder.decode(value, { stream: true }), updates);
    state = consumed.state;

    for (const parsed of consumed.parsed) {
      if (parsed.error) {
        throw parsed.error;
      }

      if (parsed.event) {
        events.push(parsed.event);
      }

      if (parsed.complete !== undefined) {
        complete = parsed.complete;
      }

      if (parsed.continue) {
        reconnect = parsed.continue;
      }
    }
  }
}

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-operator-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-operator-audits-")),
    NOTIONMCP_HOST_DURABILITY: "inline-only",
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };
  delete jobRunnerTestOverrides.runResearchAgent;
  delete jobRunnerTestOverrides.executeWriteJob;
  delete notionTestOverrides.provider;

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("operator flow persists a durable research job, supports reconnect, and writes an auditable reviewed payload", async () => {
  const researchPrompt = "Find Acme alternatives with public pricing pages";
  const searchQueries = [
    "Acme alternatives pricing",
    "Acme alternatives official site",
    "Acme competitors independent review",
    "Acme alternatives github",
    "Acme alternatives analyst coverage",
  ];
  const researchResult: ResearchResult = {
    suggestedDbTitle: "Acme Alternatives",
    summary: "Reviewed public sources identify Beta Suite as a comparable option with public pricing.",
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
          sourceUrls: [
            "https://beta.example.com/pricing",
            "https://news.example.com/beta-suite-review",
          ],
          evidenceByField: {
            Name: ["Beta Suite pricing"],
            Description: ["Team plan pricing and positioning are described on the vendor page and review coverage."],
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
        searchQueries: searchQueries.length,
        candidateSources: 7,
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
          maxPlannedQueries: 8,
          maxEvidenceDocuments: 16,
          minUniqueDomains: 5,
          minSourceClasses: 4,
        },
        uniqueDomains: ["beta.example.com", "news.example.com"],
        sourceClasses: ["editorial", "official"],
      },
    },
  };
  const writes: Array<{ databaseId: string; operationKey?: string }> = [];

  jobRunnerTestOverrides.runResearchAgent = async (prompt, onUpdate, options) => {
    assert.equal(prompt, researchPrompt);
    assert.equal(options?.researchMode, "deep");

    await onUpdate("🧭 Planning higher-budget reviewed deep lane...", {
      phase: "planning",
    });
    await onUpdate(`🧭 Planned ${searchQueries.length} search queries.`, {
      phase: "planning",
      searchQueries,
    });
    await delay(350);
    await onUpdate("📄 Captured evidence from https://beta.example.com/pricing", {
      phase: "extracting",
      searchQueries,
      pagesBrowsed: 1,
      evidenceDocumentCount: 1,
    });
    await delay(350);
    await onUpdate("🧪 Verifying candidate rows against normalized evidence...", {
      phase: "verifying",
      searchQueries,
      pagesBrowsed: 2,
      evidenceDocumentCount: 2,
    });
    await delay(50);

    return researchResult;
  };

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
      const seenOperationKeys = new Set<string>();

      return {
        has(_data, operationKey) {
          return operationKey ? seenOperationKeys.has(operationKey) : false;
        },
        remember(_data, operationKey) {
          if (operationKey) {
            seenOperationKeys.add(operationKey);
          }
        },
      };
    },
    async createPage(input) {
      const operationKey = input.writeMetadata?.operationKey;
      const duplicate = input.duplicateTracker?.has(input.data, operationKey) ?? false;

      if (!duplicate) {
        input.duplicateTracker?.remember(input.data, operationKey);
      }

      writes.push({
        databaseId: input.databaseId,
        operationKey,
      });

      return { created: !duplicate };
    },
  };
  notionTestOverrides.provider = fakeProvider;

  const researchResponse = await postResearch(
    createPostRequest("http://localhost:3000/api/research", {
      prompt: researchPrompt,
      researchMode: "deep",
    })
  );

  assert.equal(researchResponse.status, 200);
  assert.match(researchResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(researchResponse.body);

  const researchReader = researchResponse.body.getReader();
  const decoder = new TextDecoder();
  const initialUpdates: string[] = [];
  let researchJobId = "";
  let parserState = createSSEParserState();

  while (initialUpdates.length < 2 || !researchJobId) {
    const { done, value } = await researchReader.read();
    assert.equal(done, false);

    const consumed = consumeAllSseMessages(parserState, decoder.decode(value, { stream: true }), initialUpdates);
    parserState = consumed.state;

    for (const parsed of consumed.parsed) {
      if (parsed.error) {
        throw parsed.error;
      }

      if (parsed.event?.name === "job") {
        researchJobId = ((parsed.event.data as { jobId?: string }).jobId ?? "").trim();
      }
    }
  }

  await researchReader.cancel();
  assert.match(researchJobId, /^[0-9a-fA-F-]{36}$/);
  assert.deepEqual(initialUpdates, [
    "🧭 Planning higher-budget reviewed deep lane...",
    "🧭 Planned 5 search queries.",
  ]);

  await delay(500);

  const reconnectedResearchResponse = await postResearch(
    createPostRequest("http://localhost:3000/api/research", {
      jobId: researchJobId,
      afterEventId: initialUpdates.length,
    })
  );
  const researchReconnect = await collectSseResponse(reconnectedResearchResponse);
  const completedResearchPayload = researchReconnect.complete as ResearchResult | undefined;

  assert.ok(completedResearchPayload);
  assert.deepEqual(researchReconnect.updates, [
    "📄 Captured evidence from https://beta.example.com/pricing",
    "🧪 Verifying candidate rows against normalized evidence...",
  ]);
  assert.equal(completedResearchPayload?.suggestedDbTitle, researchResult.suggestedDbTitle);

  const researchProofResponse = await getJobProof(
    createGetRequest(`http://localhost:3000/api/jobs/${researchJobId}`),
    {
      params: Promise.resolve({ jobId: researchJobId }),
    }
  );
  const researchProof = (await researchProofResponse.json()) as {
    status: string;
    checkpoint?: {
      phase?: string;
      searchQueries?: string[];
      evidenceDocumentCount?: number;
      pagesBrowsed?: number;
    };
    result?: ResearchResult;
  };

  assert.equal(researchProofResponse.status, 200);
  assert.equal(researchProof.status, "complete");
  assert.equal(researchProof.checkpoint?.phase, "complete");
  assert.deepEqual(researchProof.checkpoint?.searchQueries, searchQueries);
  assert.equal(researchProof.checkpoint?.evidenceDocumentCount, 2);
  assert.equal(researchProof.checkpoint?.pagesBrowsed, 2);
  assert.equal(researchProof.result?.summary, researchResult.summary);

  const writeResponse = await postWrite(
    createPostRequest("http://localhost:3000/api/write", completedResearchPayload)
  );
  const writeStream = await collectSseResponse(writeResponse);
  const writeComplete = writeStream.complete as { auditId?: string; databaseId?: string } | undefined;

  assert.ok(writeComplete?.auditId);
  assert.equal(writeComplete?.databaseId, "11111111-1111-1111-1111-111111111111");
  assert.equal(writes.length, 1);

  const auditProofResponse = await getWriteAuditProof(
    createGetRequest(`http://localhost:3000/api/write-audits/${writeComplete.auditId}`),
    {
      params: Promise.resolve({ auditId: writeComplete.auditId ?? "" }),
    }
  );
  const auditProof = (await auditProofResponse.json()) as {
    proofContract: {
      kind: string;
    };
    auditTrail: {
      sourceSet: string[];
      extractionCounts: {
        searchQueries: number;
      };
      rowsConfirmedWritten: number;
      rows: Array<{ status: string }>;
    };
  };

  assert.equal(auditProofResponse.status, 200);
  assert.equal(auditProof.proofContract.kind, "write-audit-proof");
  assert.deepEqual(auditProof.auditTrail.sourceSet, researchResult[RESEARCH_RUN_METADATA_KEY]?.sourceSet);
  assert.equal(
    auditProof.auditTrail.extractionCounts.searchQueries,
    researchResult[RESEARCH_RUN_METADATA_KEY]?.extractionCounts.searchQueries
  );
  assert.equal(auditProof.auditTrail.rowsConfirmedWritten, 1);
  assert.deepEqual(auditProof.auditTrail.rows.map((row) => row.status), ["written"]);
});

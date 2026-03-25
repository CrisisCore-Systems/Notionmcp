import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { POST as postResearch } from "@/app/api/research/route";
import { POST as postWrite } from "@/app/api/write/route";
import { jobRunnerTestOverrides } from "@/lib/job-runner";
import { claimNextNotionQueueEntry, notionQueueTestOverrides } from "@/lib/notion-mcp";
import { notionTestOverrides, type NotionProvider } from "@/lib/notion";
import { RESEARCH_RUN_METADATA_KEY, type ResearchResult } from "@/lib/research-result";
import { collectSseResponse, createPostRequest } from "@/tests/support/e2e";

const ORIGINAL_ENV = { ...process.env };

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-queue-loop-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-queue-loop-audits-")),
    NOTIONMCP_HOST_DURABILITY: "inline-only",
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };
  delete jobRunnerTestOverrides.runResearchAgent;
  delete notionQueueTestOverrides.callNotion;
  delete notionQueueTestOverrides.claimNextNotionQueueEntry;
  delete notionQueueTestOverrides.updateNotionQueueLifecycle;
  delete notionTestOverrides.provider;

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("ready item to reviewed packet claims the backlog row and writes lifecycle updates back into the same Notion item", async () => {
  const lifecycleUpdates: Array<{
    stage: string;
    message?: string;
    summary?: string;
    sourceCount?: number;
    auditUrl?: string;
    jobId?: string;
    runId?: string;
    claimedBy?: string;
  }> = [];
  const researchResult: ResearchResult = {
    suggestedDbTitle: "Acme Alternatives",
    summary: "Reviewed public sources identify Beta Suite as the strongest supported direction.",
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
            Name: ["Beta Suite pricing page"],
            Description: ["Vendor pricing page and independent review coverage support the claim."],
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
        searchQueries: 3,
        candidateSources: 5,
        pagesBrowsed: 2,
        rowsExtracted: 1,
      },
      rejectedUrls: [],
      search: {
        configuredProviders: ["duckduckgo"],
        usedProviders: ["duckduckgo"],
        degraded: false,
        mode: "deep",
        profile: {
          maxPlannedQueries: 8,
          maxEvidenceDocuments: 16,
          minUniqueDomains: 5,
          minSourceClasses: 4,
        },
        uniqueDomains: ["beta.example.com", "news.example.com"],
        sourceClasses: ["official", "editorial"],
        sourceQuality: {
          averageScore: 86.5,
          primarySourceCount: 1,
          officialSourceCount: 1,
          dateAvailableSourceCount: 1,
          authorAvailableSourceCount: 0,
          strongestSourceUrls: ["https://beta.example.com/pricing"],
        },
      },
    },
  };
  const writes: string[] = [];

  notionQueueTestOverrides.claimNextNotionQueueEntry = async (_input, { runId, claimedBy }) => {
    lifecycleUpdates.push({
      stage: "in-progress",
      runId,
      claimedBy,
      jobId: runId,
      message: "In Progress",
    });

    return {
      databaseId: "11111111111111111111111111111111",
      pageId: "22222222222222222222222222222222",
      title: "Acme backlog row",
      prompt: "Find Acme alternatives with public pricing pages",
      statusProperty: "Status",
      runId,
      claimedBy,
      propertyTypes: {
        Status: "status",
        "Research Summary": "rich_text",
        "Source Count": "number",
        "Last Run Status": "rich_text",
        "Audit URL or Job ID": "rich_text",
      },
    };
  };

  notionQueueTestOverrides.updateNotionQueueLifecycle = async (_entry, update) => {
    lifecycleUpdates.push({
      stage: update.stage,
      message: update.message,
      summary: update.result?.summary,
      sourceCount: update.result?.[RESEARCH_RUN_METADATA_KEY]?.sourceSet.length,
      auditUrl: update.auditUrl,
      jobId: update.jobId,
    });
  };

  jobRunnerTestOverrides.runResearchAgent = async (prompt, onUpdate, options) => {
    assert.equal(prompt, "Find Acme alternatives with public pricing pages");
    assert.equal(options?.researchMode, "deep");
    await onUpdate("🧭 Planned 3 search queries.", {
      phase: "planning",
      searchQueries: [
        "Acme alternatives pricing",
        "Acme alternatives public pricing",
        "Acme alternatives independent review",
      ],
    });
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

  const researchResponse = await postResearch(
    createPostRequest("http://localhost:3000/api/research", {
      researchMode: "deep",
      notionQueue: {
        databaseId: "11111111111111111111111111111111",
      },
    })
  );
  const researchStream = await collectSseResponse(researchResponse);
  const completedResearchPayload = researchStream.complete as ResearchResult | undefined;

  assert.equal(researchResponse.status, 200);
  assert.equal(researchStream.error, undefined);
  assert.ok(completedResearchPayload);
  assert.match(completedResearchPayload?.[RESEARCH_RUN_METADATA_KEY]?.notionQueue?.runId ?? "", /^[0-9a-fA-F-]{36}$/);
  assert.equal(completedResearchPayload?.[RESEARCH_RUN_METADATA_KEY]?.notionQueue?.pageId, "22222222222222222222222222222222");
  assert.deepEqual(
    lifecycleUpdates.slice(0, 2).map((entry) => entry.stage),
    ["in-progress", "needs-review"]
  );
  assert.equal(lifecycleUpdates[1]?.summary, researchResult.summary);
  assert.equal(lifecycleUpdates[1]?.sourceCount, 2);

  const writeResponse = await postWrite(
    createPostRequest("http://localhost:3000/api/write", completedResearchPayload)
  );
  const writeStream = await collectSseResponse(writeResponse);

  assert.equal(writeResponse.status, 200);
  assert.equal(writeStream.error, undefined);
  assert.equal(writes.length, 1);
  assert.equal(lifecycleUpdates.at(-1)?.stage, "packet-ready");
  assert.ok((lifecycleUpdates.at(-1)?.auditUrl ?? "").includes("/api/write-audits/"));
});

test("claimNextNotionQueueEntry only allows one concurrent claimant per queue row on the same host", async () => {
  const readyRow = {
    id: "page-ready-1",
    properties: {
      Status: {
        type: "status",
        status: { name: "Ready" },
      },
      Name: {
        type: "title",
        title: [{ plain_text: "Acme backlog row" }],
      },
      Prompt: {
        type: "rich_text",
        rich_text: [{ plain_text: "Find Acme alternatives with public pricing pages" }],
      },
      "Claimed At": {
        type: "date",
        date: null,
      },
      "Claimed By": {
        type: "rich_text",
        rich_text: [],
      },
      "Run ID": {
        type: "rich_text",
        rich_text: [],
      },
      "Last Run Status": {
        type: "rich_text",
        rich_text: [],
      },
      "Audit URL or Job ID": {
        type: "rich_text",
        rich_text: [],
      },
    },
  };
  const updateCalls: Array<{ pageId: string; runId: string }> = [];

  notionQueueTestOverrides.callNotion = async (tool, args) => {
    if (tool === "notion_retrieve_database") {
      return {
        structuredContent: {
          id: "db-claim-test",
          data_sources: [{ id: "ds-claim-test" }],
        },
      };
    }

    if (tool === "notion_query_data_source") {
      return {
        structuredContent: {
          results: [readyRow],
          has_more: false,
          next_cursor: null,
        },
      };
    }

    if (tool === "notion_update_page") {
      updateCalls.push({
        pageId: String(args.page_id),
        runId:
          (((args.properties as Record<string, unknown>)["Run ID"] as Record<string, unknown>).rich_text as Array<{
            text?: { content?: string };
          }>)[0]?.text?.content ?? "",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { structuredContent: { id: String(args.page_id) } };
    }

    throw new Error(`Unexpected Notion tool call in test: ${tool}`);
  };

  const queueConfig = {
    databaseId: "db-claim-test",
    statusProperty: "Status",
    titleProperty: "Name",
    promptProperty: "Prompt",
    readyValue: "Ready",
  };
  const [firstClaim, secondClaim] = await Promise.allSettled([
    claimNextNotionQueueEntry(queueConfig, {
      runId: "run-1",
      claimedBy: "Worker A",
    }),
    claimNextNotionQueueEntry(queueConfig, {
      runId: "run-2",
      claimedBy: "Worker B",
    }),
  ]);

  const fulfilledClaims = [firstClaim, secondClaim].filter((result) => result.status === "fulfilled");
  const rejectedClaims = [firstClaim, secondClaim].filter((result) => result.status === "rejected");

  assert.equal(fulfilledClaims.length, 1);
  assert.equal(rejectedClaims.length, 1);
  assert.match(
    rejectedClaims[0]?.reason instanceof Error
      ? rejectedClaims[0].reason.message
      : String(rejectedClaims[0]?.reason),
    /No ready Notion queue items/
  );
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0]?.pageId, "page-ready-1");
  assert.match(updateCalls[0]?.runId ?? "", /^run-[12]$/);
});

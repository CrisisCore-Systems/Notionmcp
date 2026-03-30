import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as getResearch, POST as postResearch } from "@/app/api/research/route";
import { GET as getWrite, POST as postWrite } from "@/app/api/write/route";
import { notionQueueTestOverrides } from "@/lib/notion-mcp";
import { runWithRetry } from "@/lib/retry";

const ORIGINAL_ENV = { ...process.env };

function createRequest(url: string, body: unknown) {
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

test.afterEach(async () => {
  const jobDir = process.env.JOB_STATE_DIR;
  process.env = { ...ORIGINAL_ENV };
  delete notionQueueTestOverrides.claimNextNotionQueueEntry;
  delete notionQueueTestOverrides.updateNotionQueueLifecycle;

  if (jobDir?.startsWith(path.join(os.tmpdir(), "notionmcp-routes-smoke-"))) {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("research route rejects an empty prompt before calling the agent", async () => {
  const response = await postResearch(createRequest("http://localhost:3000/api/research", { prompt: "" }));

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Prompt or notionQueue intake is required/);
});

test("research route publishes the fast and deep lane contract on GET", async () => {
  const response = await getResearch(createRequest("http://localhost:3000/api/research", {}));
  const payload = (await response.json()) as {
    workflow: {
      defaultEntry: string;
    };
    notionQueueIntake: {
      transport: string;
      defaults: {
        promptProperty: string;
      };
    };
    researchModes: {
      default: string;
      available: Array<{
        mode: string;
        minPlannedQueries?: number;
        minUniqueDomains?: number;
        minSourceClasses?: number;
        maxEvidenceDocuments?: number;
      }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "research-control");
  assert.equal(payload.workflow.defaultEntry, "notion-mcp-queue");
  assert.equal(payload.notionQueueIntake.transport, "local-mcp");
  assert.equal(payload.notionQueueIntake.defaults.promptProperty, "Research Prompt");
  assert.equal(payload.researchModes.default, "fast");
  assert.deepEqual(
    payload.researchModes.available.map((entry) => entry.mode),
    ["fast", "deep"]
  );
  const deepMode = payload.researchModes.available.find((entry) => entry.mode === "deep");
  assert.equal(deepMode?.minPlannedQueries, 5);
  assert.equal(deepMode?.minUniqueDomains, 5);
  assert.equal(deepMode?.minSourceClasses, 4);
  assert.equal(deepMode?.maxEvidenceDocuments, 16);
});

test("research route rejects unknown research lanes instead of silently falling back", async () => {
  const response = await postResearch(
    createRequest("http://localhost:3000/api/research", {
      prompt: "Find competitors to Notion",
      researchMode: "max-depth",
    })
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Supported values are: \\"fast\\", \\"deep\\"/);
});

test("research route rejects invalid Notion queue database IDs before touching MCP", async () => {
  const response = await postResearch(
    createRequest("http://localhost:3000/api/research", {
      notionQueue: {
        databaseId: "not-a-real-database-id",
      },
    })
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /valid Notion database ID is required for notionQueue intake/);
});

test("research route returns deployment readiness errors as a 503 JSON response", async () => {
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  process.env.APP_ACCESS_TOKEN = "secret-token";
  process.env.PERSISTED_STATE_ENCRYPTION_KEY = "operator-secret";

  const response = await postResearch(
    createRequest("http://localhost:3000/api/research", {
      prompt: "Find competitors to Notion",
    })
  );
  const payload = (await response.json()) as { error: string };

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-notionmcp-surface"), "research-control");
  assert.match(payload.error, /NOTIONMCP_DEPLOYMENT_MODE=remote-private-host/);
});

test("research route releases a claimed queue row as an error when durable execution readiness fails", async () => {
  const lifecycleUpdates: Array<{ stage?: string; message?: string }> = [];
  const blockedJobDir = await mkdtemp(path.join(os.tmpdir(), "notionmcp-routes-smoke-"));
  const occupiedPath = path.join(blockedJobDir, "occupied-file");
  await writeFile(occupiedPath, "occupied", "utf8");
  process.env.JOB_STATE_DIR = occupiedPath;

  notionQueueTestOverrides.claimNextNotionQueueEntry = async (_input, options) => ({
    databaseId: "12345678-1234-1234-1234-1234567890ab",
    pageId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    title: "Acme",
    prompt: "Research Acme",
    statusProperty: "Status",
    runId: options.runId,
    claimedBy: options.claimedBy,
  });
  notionQueueTestOverrides.updateNotionQueueLifecycle = async (_entry, update) => {
    lifecycleUpdates.push({ stage: update.stage, message: update.message });
  };

  const response = await postResearch(
    createRequest("http://localhost:3000/api/research", {
      notionQueue: {
        databaseId: "12345678-1234-1234-1234-1234567890ab",
      },
    })
  );
  const payload = (await response.json()) as { error: string };

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-notionmcp-surface"), "research-control");
  assert.match(payload.error, /Persisted job-state directory is not writable/);
  assert.equal(lifecycleUpdates.at(-1)?.stage, "error");
  assert.match(lifecycleUpdates.at(-1)?.message ?? "", /Persisted job-state directory is not writable/);
});

test("write route rejects an incomplete payload before touching Notion", async () => {
  const response = await postWrite(createRequest("http://localhost:3000/api/write", { foo: "bar" }));

  assert.equal(response.status, 400);
  assert.match(await response.text(), /A complete research result is required/);
});

test("write route publishes the provider and verification-artifact contract on GET", async () => {
  const response = await getWrite(createRequest("http://localhost:3000/api/write", {}));
  const payload = (await response.json()) as {
    providerArchitecture: {
      mode: string;
      posture: string;
    };
    verificationArtifacts: string[];
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "write-control");
  assert.equal(response.headers.get("x-notionmcp-provider-mode"), "local-mcp");
  assert.equal(payload.providerArchitecture.mode, "local-mcp");
  assert.equal(payload.providerArchitecture.posture, "default-transport");
  assert.deepEqual(payload.verificationArtifacts, ["/api/jobs/{jobId}", "/api/write-audits/{auditId}"]);
});

test("write route rejects resume requests without a target database", async () => {
  const response = await postWrite(
    createRequest("http://localhost:3000/api/write", {
      suggestedDbTitle: "Research",
      summary: "Summary",
      schema: { Name: "title" },
      items: [{ Name: "Alpha" }],
      resumeFromIndex: 1,
    })
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /targetDatabaseId is required when resuming/);
});

test("write route rejects invalid existing database IDs before touching Notion", async () => {
  const response = await postWrite(
    createRequest("http://localhost:3000/api/write", {
      suggestedDbTitle: "Research",
      summary: "Summary",
      schema: { Name: "title" },
      items: [{ Name: "Alpha" }],
      targetDatabaseId: "not-a-real-database-id",
    })
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /valid Notion database ID/);
});

test("runWithRetry retries transient failures before succeeding", async () => {
  let attempts = 0;

  const result = await runWithRetry(
    async () => {
      attempts += 1;

      if (attempts < 3) {
        throw new Error("try again");
      }

      return "ok";
    },
    { maxAttempts: 3, retryDelayMs: 1 }
  );

  assert.equal(result.attempt, 3);
  assert.equal(result.value, "ok");
});

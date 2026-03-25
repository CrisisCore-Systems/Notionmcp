import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as getResearch, POST as postResearch } from "@/app/api/research/route";
import { GET as getWrite, POST as postWrite } from "@/app/api/write/route";
import { runWithRetry } from "@/lib/retry";

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

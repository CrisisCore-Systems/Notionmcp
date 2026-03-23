import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as postResearch } from "@/app/api/research/route";
import { POST as postWrite } from "@/app/api/write/route";
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
  assert.match(await response.text(), /Prompt is required/);
});

test("write route rejects an incomplete payload before touching Notion", async () => {
  const response = await postWrite(createRequest("http://localhost:3000/api/write", { foo: "bar" }));

  assert.equal(response.status, 400);
  assert.match(await response.text(), /A complete research result is required/);
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

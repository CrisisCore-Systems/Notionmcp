import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as postResearch } from "@/app/api/research/route";
import { POST as postWrite } from "@/app/api/write/route";

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

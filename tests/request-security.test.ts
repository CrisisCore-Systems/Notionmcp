import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { validateApiRequest } from "@/lib/request-security";

function createRequest(url: string, headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("host", new URL(url).host);

  return new NextRequest(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({}),
  });
}

const ORIGINAL_ENV = { ...process.env };

test.afterEach(() => {
  process.env.APP_ALLOWED_ORIGIN = ORIGINAL_ENV.APP_ALLOWED_ORIGIN;
  process.env.APP_ACCESS_TOKEN = ORIGINAL_ENV.APP_ACCESS_TOKEN;
});

test("allows localhost requests without a token", () => {
  const response = validateApiRequest(createRequest("http://localhost:3000/api/research"));
  assert.equal(response, null);
});

test("rejects cross-origin requests before any other checks", async () => {
  const response = validateApiRequest(
    createRequest("http://localhost:3000/api/research", {
      origin: "https://evil.example",
    })
  );

  assert.ok(response);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Cross-origin API requests are not allowed/);
});

test("requires the configured remote token for non-local requests", async () => {
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  process.env.APP_ACCESS_TOKEN = "secret-token";

  const response = validateApiRequest(
    createRequest("https://app.example.com/api/research", {
      origin: "https://app.example.com",
    })
  );

  assert.ok(response);
  assert.equal(response.status, 401);
  assert.match(await response.text(), /valid API access token/);
});

test("accepts a matching remote token header", () => {
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  process.env.APP_ACCESS_TOKEN = "secret-token";

  const response = validateApiRequest(
    createRequest("https://app.example.com/api/research", {
      origin: "https://app.example.com",
      "x-app-access-token": "secret-token",
    })
  );

  assert.equal(response, null);
});

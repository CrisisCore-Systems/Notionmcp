import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { requestSecurityTestOverrides, validateApiRequest } from "@/lib/request-security";

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
  process.env.APP_RATE_LIMIT_MAX = ORIGINAL_ENV.APP_RATE_LIMIT_MAX;
  process.env.APP_RATE_LIMIT_WINDOW_MS = ORIGINAL_ENV.APP_RATE_LIMIT_WINDOW_MS;
  process.env.NOTIONMCP_DEPLOYMENT_MODE = ORIGINAL_ENV.NOTIONMCP_DEPLOYMENT_MODE;
  process.env.PERSISTED_STATE_ENCRYPTION_KEY = ORIGINAL_ENV.PERSISTED_STATE_ENCRYPTION_KEY;
  process.env.REMOTE_RATE_LIMIT_DIR = ORIGINAL_ENV.REMOTE_RATE_LIMIT_DIR;
  process.env.REMOTE_RATE_LIMIT_RETENTION_DAYS = ORIGINAL_ENV.REMOTE_RATE_LIMIT_RETENTION_DAYS;
  requestSecurityTestOverrides.clearRateLimitState();
});

test("allows localhost requests without a token", async () => {
  const response = await validateApiRequest(createRequest("http://localhost:3000/api/research"));
  assert.equal(response, null);
});

test("rejects cross-origin requests before any other checks", async () => {
  const response = await validateApiRequest(
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

  const response = await validateApiRequest(
    createRequest("https://app.example.com/api/research", {
      origin: "https://app.example.com",
    })
  );

  assert.ok(response);
  assert.equal(response.status, 401);
  assert.match(await response.text(), /valid API access token/);
});

test("accepts a matching remote token header", async () => {
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  process.env.APP_ACCESS_TOKEN = "secret-token";

  const response = await validateApiRequest(
    createRequest("https://app.example.com/api/research", {
      origin: "https://app.example.com",
      "x-app-access-token": "secret-token",
    })
  );

  assert.equal(response, null);
});

test("rate limits repeated remote requests even with a valid token", async () => {
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  process.env.APP_ACCESS_TOKEN = "secret-token";
  process.env.APP_RATE_LIMIT_MAX = "1";
  process.env.APP_RATE_LIMIT_WINDOW_MS = "60000";

  const first = await validateApiRequest(
    createRequest("https://app.example.com/api/research", {
      origin: "https://app.example.com",
      "x-app-access-token": "secret-token",
      "x-forwarded-for": "203.0.113.10",
    })
  );
  const second = await validateApiRequest(
    createRequest("https://app.example.com/api/research", {
      origin: "https://app.example.com",
      "x-app-access-token": "secret-token",
      "x-forwarded-for": "203.0.113.10",
    })
  );

  assert.equal(first, null);
  assert.ok(second);
  assert.equal(second?.status, 429);
  assert.match(await second!.text(), /rate limit exceeded/i);
});

test("remote-private-host rate limiting survives clearing in-memory state", async () => {
  const rateLimitDirectory = await mkdtemp(path.join(os.tmpdir(), "notionmcp-rate-limit-"));
  process.env.NOTIONMCP_DEPLOYMENT_MODE = "remote-private-host";
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  process.env.APP_ACCESS_TOKEN = "secret-token";
  process.env.PERSISTED_STATE_ENCRYPTION_KEY = "operator-secret";
  process.env.REMOTE_RATE_LIMIT_DIR = rateLimitDirectory;
  process.env.APP_RATE_LIMIT_MAX = "1";
  process.env.APP_RATE_LIMIT_WINDOW_MS = "60000";

  try {
    const first = await validateApiRequest(
      createRequest("https://app.example.com/api/research", {
        origin: "https://app.example.com",
        "x-app-access-token": "secret-token",
        "x-forwarded-for": "203.0.113.10",
      })
    );
    requestSecurityTestOverrides.clearRateLimitState();
    const second = await validateApiRequest(
      createRequest("https://app.example.com/api/research", {
        origin: "https://app.example.com",
        "x-app-access-token": "secret-token",
        "x-forwarded-for": "203.0.113.10",
      })
    );

    assert.equal(first, null);
    assert.ok(second);
    assert.equal(second?.status, 429);
  } finally {
    await rm(rateLimitDirectory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildNotionMcpEnv, DEFAULT_NOTION_API_VERSION } from "@/lib/notion-mcp";

const ORIGINAL_ENV = { ...process.env };

test.afterEach(() => {
  process.env.OPENAPI_MCP_HEADERS = ORIGINAL_ENV.OPENAPI_MCP_HEADERS;
  process.env.NOTION_API_VERSION = ORIGINAL_ENV.NOTION_API_VERSION;
});

test("buildNotionMcpEnv pins a default Notion API version when none is configured", () => {
  delete process.env.OPENAPI_MCP_HEADERS;
  delete process.env.NOTION_API_VERSION;

  const env = buildNotionMcpEnv("ntn_test_token");
  const headers = JSON.parse(env.OPENAPI_MCP_HEADERS ?? "{}") as Record<string, string>;

  assert.equal(headers.Authorization, "Bearer ntn_test_token");
  assert.equal(headers["Notion-Version"], DEFAULT_NOTION_API_VERSION);
});

test("buildNotionMcpEnv lets NOTION_API_VERSION override header JSON while preserving other headers", () => {
  process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
    Authorization: "Bearer custom-token",
    "Notion-Version": "2022-06-28",
    "X-Trace-Id": "trace-123",
  });
  process.env.NOTION_API_VERSION = "2026-03-11";

  const env = buildNotionMcpEnv("ntn_fallback_token");
  const headers = JSON.parse(env.OPENAPI_MCP_HEADERS ?? "{}") as Record<string, string>;

  assert.equal(headers.Authorization, "Bearer custom-token");
  assert.equal(headers["Notion-Version"], "2026-03-11");
  assert.equal(headers["X-Trace-Id"], "trace-123");
});

import assert from "node:assert/strict";
import test from "node:test";
import { getConfiguredNotionProviderMode } from "@/lib/notion";

function createEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { ...overrides, NODE_ENV: "test" } as NodeJS.ProcessEnv;
}

test("getConfiguredNotionProviderMode defaults to direct-api", () => {
  assert.equal(getConfiguredNotionProviderMode(createEnv()), "direct-api");
});

test("getConfiguredNotionProviderMode accepts local MCP compatibility aliases", () => {
  assert.equal(getConfiguredNotionProviderMode(createEnv({ NOTION_PROVIDER: "local-mcp" })), "local-mcp");
  assert.equal(getConfiguredNotionProviderMode(createEnv({ NOTION_PROVIDER: "mcp" })), "local-mcp");
  assert.equal(getConfiguredNotionProviderMode(createEnv({ NOTION_PROVIDER: "local" })), "local-mcp");
});

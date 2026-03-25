import assert from "node:assert/strict";
import test from "node:test";
import { getConfiguredNotionProviderMode, getCurrentNotionProviderState } from "@/lib/notion";

function createEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { ...overrides, NODE_ENV: "test" } as NodeJS.ProcessEnv;
}

test("getConfiguredNotionProviderMode defaults to local-mcp", () => {
  assert.equal(getConfiguredNotionProviderMode(createEnv()), "local-mcp");
});

test("getConfiguredNotionProviderMode accepts local MCP compatibility aliases", () => {
  assert.equal(getConfiguredNotionProviderMode(createEnv({ NOTION_PROVIDER: "local-mcp" })), "local-mcp");
  assert.equal(getConfiguredNotionProviderMode(createEnv({ NOTION_PROVIDER: "mcp" })), "local-mcp");
  assert.equal(getConfiguredNotionProviderMode(createEnv({ NOTION_PROVIDER: "local" })), "local-mcp");
  assert.equal(getConfiguredNotionProviderMode(createEnv({ NOTION_PROVIDER: "legacy-local-mcp" })), "local-mcp");
});

test("getCurrentNotionProviderState marks local MCP as the core control plane", () => {
  assert.equal(getCurrentNotionProviderState(createEnv()).posture, "core-control-plane");
  assert.equal(
    getCurrentNotionProviderState(createEnv({ NOTION_PROVIDER: "direct-api" })).posture,
    "alternate-lane"
  );
});

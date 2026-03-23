import assert from "node:assert/strict";
import test from "node:test";
import { createDirectApiNotionProvider } from "@/lib/notion/providers/direct-api";

function createEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { ...overrides, NODE_ENV: "test" } as NodeJS.ProcessEnv;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

test("direct API provider creates databases through the official REST endpoint by default", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const provider = createDirectApiNotionProvider({
    env: createEnv({
      NOTION_TOKEN: "ntn_test_token",
      NOTION_PARENT_PAGE_ID: "parent-page-id",
      NOTION_API_VERSION: "2025-09-03",
    }),
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ id: "db_123" });
    }) as typeof fetch,
  });

  const result = await provider.createDatabase({
    title: "Research Database",
    schema: {
      Name: "title",
      URL: "url",
    },
  });

  assert.equal(result.databaseId, "db_123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.notion.com/v1/databases");

  const headers = calls[0]?.init?.headers as Record<string, string>;
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;

  assert.equal(headers.Authorization, "Bearer ntn_test_token");
  assert.equal(headers["Notion-Version"], "2025-09-03");
  assert.deepEqual(body.parent, {
    type: "page_id",
    page_id: "parent-page-id",
  });
  assert.deepEqual(body.initial_data_source, {
    properties: {
      Name: { title: {} },
      URL: { url: {} },
    },
  });
});

test("direct API provider resolves data source metadata and uses data_source_id for writes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const provider = createDirectApiNotionProvider({
    env: createEnv({
      NOTION_TOKEN: "ntn_test_token",
      NOTION_PARENT_PAGE_ID: "parent-page-id",
      NOTION_API_VERSION: "2025-09-03",
    }),
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), init });

      if (String(input).endsWith("/databases/db_123")) {
        return jsonResponse({
          id: "db_123",
          data_sources: [{ id: "ds_456" }],
        });
      }

      if (String(input).endsWith("/data_sources/ds_456")) {
        return jsonResponse({
          id: "ds_456",
          properties: {
            "Operator Operation Key": { type: "rich_text" },
            "Operator Source Set": { type: "rich_text" },
            "Operator Confidence": { type: "number" },
            "Operator Evidence Summary": { type: "rich_text" },
          },
        });
      }

      if (String(input).endsWith("/pages")) {
        return jsonResponse({ id: "page_789" });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch,
  });

  const metadataSupport = await provider.getDatabaseMetadataSupport("db_123");
  const duplicateTracker = await provider.queryExistingRows({
    databaseId: "db_123",
    schema: { Name: "title" },
    options: { prefetchExisting: false },
  });

  const writeMetadata = {
    operationKey: "op-1",
    sourceSet: "https://example.com/source",
    confidenceScore: 100,
    evidenceSummary: "Evidence for Name",
  };

  const firstResult = await provider.createPage({
    databaseId: "db_123",
    data: { Name: "Alpha" },
    schema: { Name: "title" },
    duplicateTracker,
    writeMetadata,
    metadataSupport,
  });
  const secondResult = await provider.createPage({
    databaseId: "db_123",
    data: { Name: "Alpha" },
    schema: { Name: "title" },
    duplicateTracker,
    writeMetadata,
    metadataSupport,
  });

  assert.deepEqual(metadataSupport, {
    operationKey: true,
    sourceSet: true,
    confidenceScore: true,
    evidenceSummary: true,
  });
  assert.deepEqual(firstResult, { created: true });
  assert.deepEqual(secondResult, { created: false });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, "https://api.notion.com/v1/databases/db_123");
  assert.equal(calls[1]?.url, "https://api.notion.com/v1/data_sources/ds_456");
  assert.equal(calls[2]?.url, "https://api.notion.com/v1/pages");

  const body = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>;
  const properties = body.properties as Record<string, unknown>;

  assert.deepEqual(body.parent, {
    type: "data_source_id",
    data_source_id: "ds_456",
  });
  assert.ok(properties["Operator Operation Key"]);
  assert.ok(properties["Operator Source Set"]);
  assert.ok(properties["Operator Confidence"]);
  assert.ok(properties["Operator Evidence Summary"]);
});

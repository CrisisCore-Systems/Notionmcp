import assert from "node:assert/strict";
import test from "node:test";
import { GET as getQueuePreview, POST as postQueuePreview } from "@/app/api/notion-queue/preview/route";
import { notionQueueTestOverrides } from "@/lib/notion-mcp";
import { createGetRequest, createPostRequest } from "@/tests/support/e2e";

test.afterEach(() => {
  delete notionQueueTestOverrides.callNotion;
  delete notionQueueTestOverrides.claimNextNotionQueueEntry;
  delete notionQueueTestOverrides.updateNotionQueueLifecycle;
});

test("queue preview route publishes the queue inspection contract on GET", async () => {
  const response = await getQueuePreview(createGetRequest("http://localhost:3000/api/notion-queue/preview"));
  const payload = (await response.json()) as {
    route: string;
    kind: string;
    previewLimit: number;
    defaults: {
      promptProperty: string;
      statusProperty: string;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "queue-introspection");
  assert.equal(payload.route, "/api/notion-queue/preview");
  assert.equal(payload.kind, "queue-introspection");
  assert.equal(payload.previewLimit, 25);
  assert.equal(payload.defaults.promptProperty, "Research Prompt");
  assert.equal(payload.defaults.statusProperty, "Status");
});

test("queue preview route rejects invalid Notion database IDs before touching MCP", async () => {
  const response = await postQueuePreview(
    createPostRequest("http://localhost:3000/api/notion-queue/preview", {
      notionQueue: {
        databaseId: "not-a-real-database-id",
      },
    })
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /valid Notion database ID is required for notionQueue intake/);
});

test("queue preview route crawls the configured queue and reports runnable rows, statuses, and missing properties", async () => {
  notionQueueTestOverrides.callNotion = async (tool, args) => {
    if (tool === "notion_retrieve_database") {
      return {
        structuredContent: {
          id: "db-preview-test",
          data_sources: [{ id: "ds-preview-test" }],
          properties: {
            Name: { type: "title" },
            Status: { type: "status" },
          },
        },
      };
    }

    if (tool === "notion_query_data_source") {
      const startCursor = typeof args.start_cursor === "string" ? args.start_cursor : "";

      if (!startCursor) {
        return {
          structuredContent: {
            results: [
              {
                id: "page-ready-1",
                properties: {
                  Status: { type: "status", status: { name: "Ready" } },
                  Name: { type: "title", title: [{ plain_text: "Acme" }] },
                },
              },
              {
                id: "page-review-1",
                properties: {
                  Status: { type: "status", status: { name: "Needs Review" } },
                  Name: { type: "title", title: [{ plain_text: "Bravo" }] },
                },
              },
            ],
            has_more: true,
            next_cursor: "cursor-2",
          },
        };
      }

      return {
        structuredContent: {
          results: [
            {
              id: "page-ready-2",
              properties: {
                Status: { type: "status", status: { name: "Ready" } },
                Name: { type: "title", title: [] },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      };
    }

    throw new Error(`Unexpected Notion tool call in test: ${tool}`);
  };

  const response = await postQueuePreview(
    createPostRequest("http://localhost:3000/api/notion-queue/preview", {
      notionQueue: {
        databaseId: "12345678-1234-1234-1234-1234567890ab",
      },
    })
  );
  const payload = (await response.json()) as {
    totalEntries: number;
    readyEntries: number;
    readyWithUsablePromptEntries: number;
    usablePromptEntries: number;
    entries: Array<{
      pageId: string;
      isReady: boolean;
      hasUsablePrompt: boolean;
      promptSource: string;
      prompt: string;
    }>;
    statusCounts: Array<{ status: string; count: number }>;
    propertyChecks: {
      promptProperty: { exists: boolean; type: string | null };
      titleProperty: { exists: boolean; type: string | null };
      statusProperty: { exists: boolean; type: string | null };
    };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "queue-introspection");
  assert.equal(payload.totalEntries, 3);
  assert.equal(payload.readyEntries, 2);
  assert.equal(payload.usablePromptEntries, 2);
  assert.equal(payload.readyWithUsablePromptEntries, 1);
  assert.deepEqual(payload.statusCounts, [
    { status: "Ready", count: 2 },
    { status: "Needs Review", count: 1 },
  ]);
  assert.equal(payload.propertyChecks.promptProperty.exists, false);
  assert.equal(payload.propertyChecks.promptProperty.type, null);
  assert.equal(payload.propertyChecks.titleProperty.exists, true);
  assert.equal(payload.propertyChecks.titleProperty.type, "title");
  assert.equal(payload.propertyChecks.statusProperty.exists, true);
  assert.equal(payload.propertyChecks.statusProperty.type, "status");
  assert.equal(payload.entries[0]?.pageId, "page-ready-1");
  assert.equal(payload.entries[0]?.isReady, true);
  assert.equal(payload.entries[0]?.hasUsablePrompt, true);
  assert.equal(payload.entries[0]?.promptSource, "title-fallback");
  assert.match(payload.entries[0]?.prompt ?? "", /Research this Notion backlog item: Acme/);
  assert.equal(payload.entries[2]?.pageId, "page-ready-2");
  assert.equal(payload.entries[2]?.hasUsablePrompt, false);
  assert.equal(payload.entries[2]?.promptSource, "missing");
});
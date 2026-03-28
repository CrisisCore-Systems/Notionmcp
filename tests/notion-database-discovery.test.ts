import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET as getNotionDatabases } from "@/app/api/notion/databases/route";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  persistNotionConnection,
  type NotionConnectionRecord,
} from "@/lib/notion-oauth";
import { createGetRequest } from "@/tests/support/e2e";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    NOTION_CLIENT_ID: "client_test",
    NOTION_CLIENT_SECRET: "secret_test",
    NOTION_OAUTH_REDIRECT_URI: "http://localhost:3000/api/notion/callback",
    NOTION_CONNECTION_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-database-discovery-")),
  };
});

test.afterEach(async () => {
  const connectionDir = process.env.NOTION_CONNECTION_DIR;
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;

  if (connectionDir) {
    await rm(connectionDir, { recursive: true, force: true });
  }
});

test("notion database discovery requires an active linked workspace", async () => {
  const response = await getNotionDatabases(createGetRequest("http://localhost:3000/api/notion/databases"));
  const payload = (await response.json()) as {
    error: string;
    discoveryContract: { kind: string; route: string };
  };

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-notionmcp-surface"), "notion-discovery");
  assert.match(payload.error, /Connect a Notion workspace first/i);
  assert.equal(payload.discoveryContract.kind, "notion-discovery");
  assert.equal(payload.discoveryContract.route, "/api/notion/databases");
});

test("notion database discovery lists connected workspace databases and infers queue fields", async () => {
  const connection: NotionConnectionRecord = {
    connectionId: "workspace-123",
    workspaceId: "workspace-123",
    workspaceName: "Kay Workspace",
    workspaceIcon: null,
    botId: "bot-123",
    accessToken: "secret_access_token",
    source: "oauth",
    owner: {
      type: "user",
      userId: "user-123",
      userName: "Kay",
      avatarUrl: null,
    },
    connectedAt: "2026-03-27T12:00:00.000Z",
    updatedAt: "2026-03-27T12:00:00.000Z",
  };

  await persistNotionConnection(connection);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret_access_token");

    if (url.endsWith("/v1/search")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "db-queue-1",
              title: [{ plain_text: "Research Intake" }],
              url: "https://www.notion.so/db-queue-1",
              last_edited_time: "2026-03-27T11:55:00.000Z",
            },
            {
              id: "db-queue-2",
              title: [{ plain_text: "Idea Pipeline" }],
              url: "https://www.notion.so/db-queue-2",
              last_edited_time: "2026-03-27T11:20:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.endsWith("/v1/databases/db-queue-1")) {
      return new Response(
        JSON.stringify({
          id: "db-queue-1",
          title: [{ plain_text: "Research Intake" }],
          url: "https://www.notion.so/db-queue-1",
          description: [{ plain_text: "Primary reviewed research queue" }],
          last_edited_time: "2026-03-27T11:55:00.000Z",
          data_sources: [{ id: "ds-queue-1" }],
          properties: {
            Name: { type: "title" },
            "Research Prompt": { type: "rich_text" },
            Status: { type: "status" },
            Notes: { type: "rich_text" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.endsWith("/v1/databases/db-queue-2")) {
      return new Response(
        JSON.stringify({
          id: "db-queue-2",
          title: [{ plain_text: "Idea Pipeline" }],
          url: "https://www.notion.so/db-queue-2",
          description: [{ plain_text: "Earlier stage intake" }],
          last_edited_time: "2026-03-27T11:20:00.000Z",
          data_sources: [{ id: "ds-queue-2" }],
          properties: {
            Title: { type: "title" },
            Brief: { type: "rich_text" },
            Stage: { type: "select" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const response = await getNotionDatabases(
    createGetRequest("http://localhost:3000/api/notion/databases", {
      cookie: `${ACTIVE_NOTION_CONNECTION_COOKIE_NAME}=workspace-123`,
    })
  );
  const payload = (await response.json()) as {
    activeConnection: { workspaceName: string } | null;
    databases: Array<{
      databaseId: string;
      title: string;
      dataSourceId: string | null;
      properties: Array<{ name: string; type: string }>;
      suggestedQueueProperties: {
        promptProperty: string | null;
        titleProperty: string | null;
        statusProperty: string | null;
      };
    }>;
    discoveryContract: { kind: string; route: string };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "notion-discovery");
  assert.equal(payload.activeConnection?.workspaceName, "Kay Workspace");
  assert.equal(payload.databases.length, 2);
  assert.equal(payload.databases[0]?.databaseId, "db-queue-1");
  assert.equal(payload.databases[0]?.title, "Research Intake");
  assert.equal(payload.databases[0]?.dataSourceId, "ds-queue-1");
  assert.deepEqual(payload.databases[0]?.suggestedQueueProperties, {
    promptProperty: "Research Prompt",
    titleProperty: "Name",
    statusProperty: "Status",
  });
  assert.deepEqual(payload.databases[1]?.suggestedQueueProperties, {
    promptProperty: "Brief",
    titleProperty: "Title",
    statusProperty: "Stage",
  });
  assert.deepEqual(
    payload.databases[0]?.properties.map((property) => property.name),
    ["Name", "Notes", "Research Prompt", "Status"]
  );
  assert.equal(payload.discoveryContract.kind, "notion-discovery");
  assert.equal(payload.discoveryContract.route, "/api/notion/databases");
});
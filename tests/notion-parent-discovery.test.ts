import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET as getNotionParents } from "@/app/api/notion/parents/route";
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
    NOTION_CONNECTION_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-parent-discovery-")),
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

test("notion parent discovery requires an active linked workspace", async () => {
  const response = await getNotionParents(createGetRequest("http://localhost:3000/api/notion/parents"));
  const payload = (await response.json()) as {
    error: string;
    discoveryContract: { kind: string; route: string };
  };

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-notionmcp-surface"), "notion-discovery");
  assert.match(payload.error, /Connect a Notion workspace first/i);
  assert.equal(payload.discoveryContract.kind, "notion-discovery");
  assert.equal(payload.discoveryContract.route, "/api/notion/parents");
});

test("notion parent discovery lists candidate parent pages from the connected workspace", async () => {
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
              id: "page-parent-1",
              url: "https://www.notion.so/page-parent-1",
              last_edited_time: "2026-03-27T11:55:00.000Z",
              parent: { type: "workspace", workspace: true },
              properties: {
                title: {
                  id: "title",
                  type: "title",
                  title: [{ plain_text: "Research Ops" }],
                },
              },
            },
            {
              id: "page-parent-2",
              url: "https://www.notion.so/page-parent-2",
              last_edited_time: "2026-03-27T10:15:00.000Z",
              parent: { type: "page_id", page_id: "root-page" },
              properties: {
                Name: {
                  id: "title",
                  type: "title",
                  title: [{ plain_text: "Client Work" }],
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const response = await getNotionParents(
    createGetRequest("http://localhost:3000/api/notion/parents", {
      cookie: `${ACTIVE_NOTION_CONNECTION_COOKIE_NAME}=workspace-123`,
    })
  );
  const payload = (await response.json()) as {
    activeConnection: { workspaceName: string } | null;
    parents: Array<{
      pageId: string;
      title: string;
      parentType: string | null;
      lastEditedTime: string | null;
      url: string | null;
    }>;
    discoveryContract: { kind: string; route: string };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "notion-discovery");
  assert.equal(payload.activeConnection?.workspaceName, "Kay Workspace");
  assert.deepEqual(payload.parents, [
    {
      pageId: "page-parent-1",
      title: "Research Ops",
      parentType: "workspace",
      lastEditedTime: "2026-03-27T11:55:00.000Z",
      url: "https://www.notion.so/page-parent-1",
    },
    {
      pageId: "page-parent-2",
      title: "Client Work",
      parentType: "page_id",
      lastEditedTime: "2026-03-27T10:15:00.000Z",
      url: "https://www.notion.so/page-parent-2",
    },
  ]);
  assert.equal(payload.discoveryContract.kind, "notion-discovery");
  assert.equal(payload.discoveryContract.route, "/api/notion/parents");
});
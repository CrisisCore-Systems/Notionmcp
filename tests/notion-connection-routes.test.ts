import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET as getNotionCallback } from "@/app/api/notion/callback/route";
import { GET as getNotionConnection } from "@/app/api/notion/connection/route";
import { GET as getNotionConnect } from "@/app/api/notion/connect/route";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  ACTIVE_NOTION_CONNECTION_RECORD_COOKIE_NAME,
  NOTION_OAUTH_STATE_COOKIE_NAME,
  type NotionConnectionRecord,
} from "@/lib/notion-oauth";
import { encryptSessionValue } from "@/lib/session-crypto";
import { createGetRequest } from "@/tests/support/e2e";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    NOTION_CLIENT_ID: "client_test",
    NOTION_CLIENT_SECRET: "secret_test",
    NOTION_OAUTH_REDIRECT_URI: "http://localhost:3000/api/notion/callback",
    NOTION_CONNECTION_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-connections-")),
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

test("notion connect route redirects to Notion OAuth and sets the state cookie", async () => {
  const response = await getNotionConnect(createGetRequest("http://localhost:3000/api/notion/connect"));

  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") ?? "", /^https:\/\/api\.notion\.com\/v1\/oauth\/authorize/);
  assert.match(response.headers.get("set-cookie") ?? "", new RegExp(NOTION_OAUTH_STATE_COOKIE_NAME));
});

test("notion callback persists the connection and exposes it through the connection status route", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: "secret_access_token",
        workspace_id: "workspace-123",
        workspace_name: "Kay Workspace",
        workspace_icon: "🧠",
        bot_id: "bot-123",
        owner: {
          type: "user",
          user: {
            id: "user-123",
            name: "Kay",
            avatar_url: "https://example.com/avatar.png",
          },
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

  const callbackResponse = await getNotionCallback(
    createGetRequest(
      "http://localhost:3000/api/notion/callback?code=code-123&state=state-123",
      {
        cookie: `${NOTION_OAUTH_STATE_COOKIE_NAME}=state-123`,
      }
    )
  );

  assert.equal(callbackResponse.status, 307);
  assert.match(callbackResponse.headers.get("location") ?? "", /notion_connected=Kay(?:%20|\+)Workspace/);
  const setCookieHeader = callbackResponse.headers.get("set-cookie") ?? "";
  assert.match(setCookieHeader, new RegExp(ACTIVE_NOTION_CONNECTION_COOKIE_NAME));

  const connectionResponse = await getNotionConnection(
    createGetRequest("http://localhost:3000/api/notion/connection", {
      cookie: `${ACTIVE_NOTION_CONNECTION_COOKIE_NAME}=workspace-123`,
    })
  );
  const payload = (await connectionResponse.json()) as {
    oauth: { configured: boolean };
    activeConnection: {
      workspaceName: string;
      workspaceId: string;
      owner: { userName: string | null };
    } | null;
    savedConnections: Array<{ connectionId: string }>;
    connectionContract: { kind: string; route: string };
  };

  assert.equal(connectionResponse.status, 200);
  assert.equal(connectionResponse.headers.get("x-notionmcp-surface"), "notion-connection");
  assert.equal(payload.oauth.configured, true);
  assert.equal(payload.activeConnection?.workspaceName, "Kay Workspace");
  assert.equal(payload.activeConnection?.workspaceId, "workspace-123");
  assert.equal(payload.activeConnection?.owner.userName, "Kay");
  assert.equal(payload.savedConnections.length, 1);
  assert.equal(payload.savedConnections[0]?.connectionId, "workspace-123");
  assert.equal(payload.connectionContract.kind, "notion-connection");
  assert.equal(payload.connectionContract.route, "/api/notion/connection");
});

test("notion callback rejects a mismatched OAuth state", async () => {
  const response = await getNotionCallback(
    createGetRequest(
      "http://localhost:3000/api/notion/callback?code=code-123&state=wrong-state",
      {
        cookie: `${NOTION_OAUTH_STATE_COOKIE_NAME}=expected-state`,
      }
    )
  );

  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") ?? "", /notion_oauth_error=state_mismatch/);
});

test("notion connection route restores the active workspace from the encrypted session cookie on inline-only hosts", async () => {
  process.env.NOTIONMCP_HOST_DURABILITY = "inline-only";

  const connection: NotionConnectionRecord = {
    connectionId: "workspace-inline",
    workspaceId: "workspace-inline",
    workspaceName: "Inline Workspace",
    workspaceIcon: null,
    botId: "bot-inline",
    accessToken: "inline_access_token",
    source: "oauth",
    owner: {
      type: "user",
      userId: "user-inline",
      userName: "Kay",
      avatarUrl: null,
    },
    connectedAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
  };

  const response = await getNotionConnection(
    createGetRequest("http://localhost:3000/api/notion/connection", {
      cookie: `${ACTIVE_NOTION_CONNECTION_COOKIE_NAME}=workspace-inline; ${ACTIVE_NOTION_CONNECTION_RECORD_COOKIE_NAME}=${encryptSessionValue(connection)}`,
    })
  );
  const payload = (await response.json()) as {
    activeConnection: { workspaceName: string; workspaceId: string } | null;
    savedConnections: Array<{ connectionId: string }>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.activeConnection?.workspaceName, "Inline Workspace");
  assert.equal(payload.activeConnection?.workspaceId, "workspace-inline");
  assert.ok(payload.savedConnections.some((entry) => entry.connectionId === "workspace-inline"));
});
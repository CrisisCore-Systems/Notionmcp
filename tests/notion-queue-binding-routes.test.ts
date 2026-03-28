import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GET as getNotionQueueBinding, POST as postNotionQueueBinding } from "@/app/api/notion/queue-binding/route";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  persistNotionConnection,
  type NotionConnectionRecord,
} from "@/lib/notion-oauth";
import { createGetRequest, createPostRequest } from "@/tests/support/e2e";

const ORIGINAL_ENV = { ...process.env };

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    NOTION_CLIENT_ID: "client_test",
    NOTION_CLIENT_SECRET: "secret_test",
    NOTION_OAUTH_REDIRECT_URI: "http://localhost:3000/api/notion/callback",
    NOTION_CONNECTION_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-queue-binding-connections-")),
    NOTION_QUEUE_BINDING_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-queue-bindings-")),
  };
});

test.afterEach(async () => {
  const directories = [process.env.NOTION_CONNECTION_DIR, process.env.NOTION_QUEUE_BINDING_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function createConnection(): NotionConnectionRecord {
  return {
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
}

test("queue binding route requires an active linked workspace", async () => {
  const response = await getNotionQueueBinding(createGetRequest("http://localhost:3000/api/notion/queue-binding"));
  const payload = (await response.json()) as {
    error: string;
    bindingContract: { kind: string; route: string };
  };

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-notionmcp-surface"), "notion-binding");
  assert.match(payload.error, /Connect a Notion workspace first/i);
  assert.equal(payload.bindingContract.kind, "notion-binding");
  assert.equal(payload.bindingContract.route, "/api/notion/queue-binding");
});

test("queue binding route saves and restores the active linked workspace queue setup", async () => {
  await persistNotionConnection(createConnection());

  const saveResponse = await postNotionQueueBinding(
    createPostRequest(
      "http://localhost:3000/api/notion/queue-binding",
      {
        notionQueue: {
          databaseId: "12345678-1234-1234-1234-1234567890ab",
          promptProperty: "Research Prompt",
          titleProperty: "Name",
          statusProperty: "Status",
          readyValue: "Ready",
        },
      },
      {
        cookie: `${ACTIVE_NOTION_CONNECTION_COOKIE_NAME}=workspace-123`,
      }
    )
  );
  const savedPayload = (await saveResponse.json()) as {
    binding: {
      connectionId: string;
      notionQueue: { databaseId: string; promptProperty: string };
    };
    bindingContract: { kind: string };
  };

  assert.equal(saveResponse.status, 200);
  assert.equal(saveResponse.headers.get("x-notionmcp-surface"), "notion-binding");
  assert.equal(savedPayload.binding.connectionId, "workspace-123");
  assert.equal(savedPayload.binding.notionQueue.databaseId, "12345678-1234-1234-1234-1234567890ab");
  assert.equal(savedPayload.binding.notionQueue.promptProperty, "Research Prompt");
  assert.equal(savedPayload.bindingContract.kind, "notion-binding");

  const loadResponse = await getNotionQueueBinding(
    createGetRequest("http://localhost:3000/api/notion/queue-binding", {
      cookie: `${ACTIVE_NOTION_CONNECTION_COOKIE_NAME}=workspace-123`,
    })
  );
  const loadedPayload = (await loadResponse.json()) as {
    activeConnection: { workspaceName: string } | null;
    binding: {
      connectionId: string;
      notionQueue: { titleProperty: string; statusProperty: string; readyValue: string };
    } | null;
  };

  assert.equal(loadResponse.status, 200);
  assert.equal(loadedPayload.activeConnection?.workspaceName, "Kay Workspace");
  assert.equal(loadedPayload.binding?.connectionId, "workspace-123");
  assert.equal(loadedPayload.binding?.notionQueue.titleProperty, "Name");
  assert.equal(loadedPayload.binding?.notionQueue.statusProperty, "Status");
  assert.equal(loadedPayload.binding?.notionQueue.readyValue, "Ready");
});
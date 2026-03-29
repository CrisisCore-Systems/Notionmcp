import path from "node:path";
import { isInlineOnlyHost } from "@/lib/deployment-boundary";
import { readPersistedStateFile, writePersistedStateFile } from "@/lib/persisted-state";
import { decryptSessionValue, encryptSessionValue } from "@/lib/session-crypto";
import type { NotionQueueConfig } from "@/lib/notion-queue";

const NOTION_QUEUE_BINDING_RETENTION_ENV_VAR = "NOTION_QUEUE_BINDING_RETENTION_DAYS";
export const ACTIVE_NOTION_QUEUE_BINDING_COOKIE_NAME = "notionmcp-active-notion-queue-binding";

const notionQueueBindingCache = new Map<string, PersistedNotionQueueBinding>();

export type PersistedNotionQueueBinding = {
  connectionId: string;
  notionQueue: NotionQueueConfig;
  updatedAt: string;
};

function getNotionQueueBindingDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NOTION_QUEUE_BINDING_DIR?.trim();
  return configured || path.join(process.cwd(), ".notionmcp-data", "notion-queue-bindings");
}

function getNotionQueueBindingPath(connectionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getNotionQueueBindingDirectory(env), `${encodeURIComponent(connectionId)}.json`);
}

export async function persistNotionQueueBinding(
  connectionId: string,
  notionQueue: NotionQueueConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedNotionQueueBinding> {
  const record: PersistedNotionQueueBinding = {
    connectionId,
    notionQueue,
    updatedAt: new Date().toISOString(),
  };

  notionQueueBindingCache.set(connectionId, record);

  if (isInlineOnlyHost(env)) {
    return record;
  }

  await writePersistedStateFile(
    getNotionQueueBindingPath(connectionId, env),
    record,
    NOTION_QUEUE_BINDING_RETENTION_ENV_VAR,
    env
  );

  return record;
}

export async function loadNotionQueueBinding(
  connectionId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<PersistedNotionQueueBinding | null> {
  const cached = notionQueueBindingCache.get(connectionId.trim());

  if (cached) {
    return cached;
  }

  try {
    const binding = await readPersistedStateFile<PersistedNotionQueueBinding>(
      getNotionQueueBindingPath(connectionId, env),
      NOTION_QUEUE_BINDING_RETENTION_ENV_VAR,
      env
    );

    notionQueueBindingCache.set(binding.connectionId, binding);
    return binding;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function readNotionQueueBindingCookie(
  serialized: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): PersistedNotionQueueBinding | null {
  const binding = decryptSessionValue<PersistedNotionQueueBinding>(serialized, env);

  if (!binding?.connectionId || !binding.notionQueue?.databaseId) {
    return null;
  }

  notionQueueBindingCache.set(binding.connectionId, binding);
  return binding;
}

export function buildNotionQueueBindingCookieValue(
  binding: PersistedNotionQueueBinding,
  env: NodeJS.ProcessEnv = process.env
): string {
  notionQueueBindingCache.set(binding.connectionId, binding);
  return encryptSessionValue(binding, env);
}
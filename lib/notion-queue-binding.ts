import path from "node:path";
import { readPersistedStateFile, writePersistedStateFile } from "@/lib/persisted-state";
import type { NotionQueueConfig } from "@/lib/notion-queue";

const NOTION_QUEUE_BINDING_RETENTION_ENV_VAR = "NOTION_QUEUE_BINDING_RETENTION_DAYS";

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
  try {
    return await readPersistedStateFile<PersistedNotionQueueBinding>(
      getNotionQueueBindingPath(connectionId, env),
      NOTION_QUEUE_BINDING_RETENTION_ENV_VAR,
      env
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
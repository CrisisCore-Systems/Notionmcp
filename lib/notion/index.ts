import { buildOperationalSchema } from "@/lib/notion/domain";
import { loadNotionConnection } from "@/lib/notion-oauth";
import type { NotionProvider } from "@/lib/notion/provider";
import { createDirectApiNotionProvider } from "@/lib/notion/providers/direct-api";
import { createLocalMcpNotionProvider } from "@/lib/notion/providers/local-mcp";

export { buildOperationalSchema };
export type {
  CreatePageInput,
  DuplicateTracker,
  ExistingRowIndex,
  NotionProvider,
  NotionSchema,
  NotionWriteMetadataSupport,
  QueryExistingRowsInput,
} from "@/lib/notion/provider";

export type NotionProviderMode = "direct-api" | "local-mcp";

export type NotionExecutionContext = {
  connectionId?: string | null;
};

function normalizeProviderMode(value: string | undefined): NotionProviderMode {
  const normalized = value?.trim().toLowerCase();

  if (
    !normalized ||
    normalized === "local-mcp" ||
    normalized === "legacy-local-mcp" ||
    normalized === "local" ||
    normalized === "mcp"
  ) {
    return "local-mcp";
  }

  if (
    normalized === "direct-api" ||
    normalized === "direct" ||
    normalized === "api"
  ) {
    return "direct-api";
  }

  return "local-mcp";
}

export function getConfiguredNotionProviderMode(env: NodeJS.ProcessEnv = process.env): NotionProviderMode {
  return normalizeProviderMode(env.NOTION_PROVIDER);
}

export function getCurrentNotionProviderState(env: NodeJS.ProcessEnv = process.env): {
  mode: NotionProviderMode;
  health: "configured";
  posture: "default-transport" | "alternate-transport";
  description: string;
} {
  const mode = getConfiguredNotionProviderMode(env);

  return {
    mode,
    health: "configured",
    posture: mode === "local-mcp" ? "default-transport" : "alternate-transport",
    description:
      mode === "local-mcp"
        ? "Local Notion MCP is the default transport for Notion queue intake and reviewed writes."
        : "Direct Notion API remains available as an alternate private-host transport lane.",
  };
}

export function createNotionProvider(env: NodeJS.ProcessEnv = process.env): NotionProvider {
  return getConfiguredNotionProviderMode(env) === "local-mcp"
    ? createLocalMcpNotionProvider()
    : createDirectApiNotionProvider({ env });
}

export async function createNotionProviderForExecution(
  context: NotionExecutionContext = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<NotionProvider> {
  const connectionId = context.connectionId?.trim();

  if (!connectionId) {
    return getNotionProvider(env);
  }

  const connection = await loadNotionConnection(connectionId, env);

  if (!connection) {
    throw new Error(`No saved Notion connection was found for connection "${connectionId}".`);
  }

  return createDirectApiNotionProvider({
    env,
    accessToken: connection.accessToken,
  });
}

export async function getNotionProviderStateForExecution(
  context: NotionExecutionContext = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  mode: NotionProviderMode;
  health: "configured";
  posture: "default-transport" | "alternate-transport";
  description: string;
}> {
  const connectionId = context.connectionId?.trim();

  if (!connectionId) {
    return getCurrentNotionProviderState(env);
  }

  const connection = await loadNotionConnection(connectionId, env);

  if (!connection) {
    throw new Error(`No saved Notion connection was found for connection "${connectionId}".`);
  }

  return {
    mode: "direct-api",
    health: "configured",
    posture: "alternate-transport",
    description: `Linked Notion workspace \"${connection.workspaceName}\" is driving execution through the direct API lane.`,
  };
}

let cachedProvider: NotionProvider | null = null;
let cachedProviderMode: NotionProviderMode | null = null;
export const notionTestOverrides: {
  provider?: NotionProvider;
} = {};

export function getNotionProvider(env: NodeJS.ProcessEnv = process.env): NotionProvider {
  if (env === process.env && notionTestOverrides.provider) {
    return notionTestOverrides.provider;
  }

  if (env !== process.env) {
    return createNotionProvider(env);
  }

  const mode = getConfiguredNotionProviderMode(env);

  if (!cachedProvider || cachedProviderMode !== mode) {
    cachedProvider = createNotionProvider(env);
    cachedProviderMode = mode;
  }

  return cachedProvider;
}

export async function createDatabase(
  title: string,
  schema: import("@/lib/notion/provider").NotionSchema,
  context?: NotionExecutionContext,
  options?: { parentPageId?: string }
) {
  return (
    await (await createNotionProviderForExecution(context)).createDatabase({
      title,
      schema,
      ...(options?.parentPageId ? { parentPageId: options.parentPageId } : {}),
    })
  ).databaseId;
}

export async function getDatabaseMetadataSupport(databaseId: string, context?: NotionExecutionContext) {
  return await (await createNotionProviderForExecution(context)).getDatabaseMetadataSupport(databaseId);
}

export async function createDuplicateTracker(
  databaseId: string,
  schema: import("@/lib/notion/provider").NotionSchema,
  options?: import("@/lib/notion/provider").QueryExistingRowsInput["options"],
  context?: NotionExecutionContext
) {
  return await (await createNotionProviderForExecution(context)).queryExistingRows({ databaseId, schema, options });
}

export async function addRow(
  databaseId: string,
  data: import("@/lib/research-result").ResearchItem,
  schema: import("@/lib/notion/provider").NotionSchema,
  duplicateTracker?: import("@/lib/notion/provider").DuplicateTracker,
  writeMetadata?: import("@/lib/write-audit").RowWriteMetadata,
  metadataSupport?: import("@/lib/notion/provider").NotionWriteMetadataSupport,
  context?: NotionExecutionContext
) {
  return await (await createNotionProviderForExecution(context)).createPage({
    databaseId,
    data,
    schema,
    duplicateTracker,
    writeMetadata,
    metadataSupport,
  });
}

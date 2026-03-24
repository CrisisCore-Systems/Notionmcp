import { buildOperationalSchema } from "@/lib/notion/domain";
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

function normalizeProviderMode(value: string | undefined): NotionProviderMode {
  const normalized = value?.trim().toLowerCase();

  if (
    normalized === "local" ||
    normalized === "local-mcp" ||
    normalized === "legacy-local-mcp" ||
    normalized === "mcp"
  ) {
    return "local-mcp";
  }

  return "direct-api";
}

export function getConfiguredNotionProviderMode(env: NodeJS.ProcessEnv = process.env): NotionProviderMode {
  return normalizeProviderMode(env.NOTION_PROVIDER);
}

export function getCurrentNotionProviderState(env: NodeJS.ProcessEnv = process.env): {
  mode: NotionProviderMode;
  health: "configured";
  posture: "canonical" | "legacy-fallback";
  description: string;
} {
  const mode = getConfiguredNotionProviderMode(env);

  return {
    mode,
    health: "configured",
    posture: mode === "direct-api" ? "canonical" : "legacy-fallback",
    description:
      mode === "direct-api"
        ? "Direct Notion API is the canonical provider path."
        : "Local MCP remains available only as a legacy compatibility fallback.",
  };
}

export function createNotionProvider(env: NodeJS.ProcessEnv = process.env): NotionProvider {
  return getConfiguredNotionProviderMode(env) === "local-mcp"
    ? createLocalMcpNotionProvider()
    : createDirectApiNotionProvider({ env });
}

let cachedProvider: NotionProvider | null = null;
let cachedProviderMode: NotionProviderMode | null = null;

export function getNotionProvider(env: NodeJS.ProcessEnv = process.env): NotionProvider {
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

export async function createDatabase(title: string, schema: import("@/lib/notion/provider").NotionSchema) {
  return (await getNotionProvider().createDatabase({ title, schema })).databaseId;
}

export async function getDatabaseMetadataSupport(databaseId: string) {
  return await getNotionProvider().getDatabaseMetadataSupport(databaseId);
}

export async function createDuplicateTracker(
  databaseId: string,
  schema: import("@/lib/notion/provider").NotionSchema,
  options?: import("@/lib/notion/provider").QueryExistingRowsInput["options"]
) {
  return await getNotionProvider().queryExistingRows({ databaseId, schema, options });
}

export async function addRow(
  databaseId: string,
  data: import("@/lib/research-result").ResearchItem,
  schema: import("@/lib/notion/provider").NotionSchema,
  duplicateTracker?: import("@/lib/notion/provider").DuplicateTracker,
  writeMetadata?: import("@/lib/write-audit").RowWriteMetadata,
  metadataSupport?: import("@/lib/notion/provider").NotionWriteMetadataSupport
) {
  return await getNotionProvider().createPage({
    databaseId,
    data,
    schema,
    duplicateTracker,
    writeMetadata,
    metadataSupport,
  });
}

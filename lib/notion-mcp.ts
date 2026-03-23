import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createRequire } from "node:module";

let mcpClient: Client | null = null;
let mcpTransport: Transport | null = null;
const NOTION_API_VERSION = "2022-06-28";
const require = createRequire(import.meta.url);
const dataSourceIdCache = new Map<string, string>();
const TOOL_NAME_ALIASES: Record<string, string[]> = {
  notion_create_database: ["notion_create_database", "API-create-a-data-source"],
  notion_create_page: ["notion_create_page", "API-post-page"],
  notion_retrieve_database: ["notion_retrieve_database", "API-retrieve-a-database"],
  notion_query_data_source: ["notion_query_data_source", "API-query-data-source"],
};

interface NotionToolResponse {
  content?: unknown;
  structuredContent?: unknown;
}

interface NotionRecordWithId {
  id: string;
}

interface NotionDataSourceRecord extends NotionRecordWithId {
  data_sources: NotionRecordWithId[];
}

interface NotionQueryResult {
  results: unknown[];
}

/** Read a required environment variable or throw a setup error. */
function getRequiredEnv(name: "NOTION_TOKEN" | "NOTION_PARENT_PAGE_ID"): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and set the required Notion credentials.`
    );
  }

  return value;
}

function getNotionMcpCommand(): string {
  return require.resolve("@notionhq/notion-mcp-server/bin/cli.mjs");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRecordWithId(value: unknown): value is NotionRecordWithId {
  return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function isDatabaseWithDataSources(value: unknown): value is NotionDataSourceRecord {
  if (!isRecordWithId(value) || !isRecord(value)) {
    return false;
  }

  const dataSources = value.data_sources;

  return (
    Array.isArray(dataSources) &&
    dataSources.every(isRecordWithId)
  );
}

function isQueryResult(value: unknown): value is NotionQueryResult {
  return isRecord(value) && Array.isArray(value.results);
}

function extractStructuredPayload<T>(
  response: NotionToolResponse,
  isMatch: (value: unknown) => value is T
): T | null {
  const queue: unknown[] = [response.structuredContent, response.content];

  while (queue.length > 0) {
    const candidate = queue.shift();

    if (candidate == null) {
      continue;
    }

    if (isMatch(candidate)) {
      return candidate;
    }

    if (typeof candidate === "string") {
      try {
        queue.push(JSON.parse(candidate));
      } catch {
        continue;
      }

      continue;
    }

    if (Array.isArray(candidate)) {
      queue.push(...candidate);
      continue;
    }

    if (!isRecord(candidate)) {
      continue;
    }

    if (typeof candidate.text === "string") {
      try {
        queue.push(JSON.parse(candidate.text));
      } catch {
        // Some tool responses include plain text. Ignore non-JSON text payloads.
      }
    }

    queue.push(...Object.values(candidate));
  }

  return null;
}

/** Lazily start and connect to the Notion MCP server subprocess */
async function getClient(): Promise<Client> {
  if (mcpClient) return mcpClient;
  const notionToken = getRequiredEnv("NOTION_TOKEN");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [getNotionMcpCommand()],
    env: {
      ...process.env,
      // Notion MCP server reads auth from this header string
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": NOTION_API_VERSION,
      }),
    },
  });

  mcpClient = new Client(
    { name: "notion-research-agent", version: "1.0.0" },
    { capabilities: {} }
  );
  mcpTransport = transport;

  try {
    await mcpClient.connect(transport);
  } catch (error) {
    await resetClient();
    throw error;
  }

  return mcpClient;
}

async function resetClient(): Promise<void> {
  dataSourceIdCache.clear();

  const client = mcpClient;
  const transport = mcpTransport;
  mcpClient = null;
  mcpTransport = null;

  await Promise.allSettled([
    typeof client?.close === "function" ? client.close() : Promise.resolve(),
    typeof transport?.close === "function" ? transport.close() : Promise.resolve(),
  ]);
}

function getToolCandidates(tool: string): string[] {
  return TOOL_NAME_ALIASES[tool] ?? [tool];
}

function isRecoverableTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    message.includes("transport") ||
    message.includes("disconnected") ||
    message.includes("closed") ||
    message.includes("broken pipe") ||
    message.includes("econnreset") ||
    message.includes("not connected")
  );
}

async function callNotionToolOnce(
  tool: string,
  args: Record<string, unknown>
): Promise<NotionToolResponse> {
  const client = await getClient();
  let lastError: unknown;

  for (const candidate of getToolCandidates(tool)) {
    try {
      const result = await client.callTool({ name: candidate, arguments: args });

      if (result.isError) {
        throw new Error(`Notion MCP error on "${candidate}": ${JSON.stringify(result.content)}`);
      }

      return {
        content: result.content,
        structuredContent: "structuredContent" in result ? result.structuredContent : undefined,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Call any Notion MCP tool by name */
export async function callNotion(
  tool: string,
  args: Record<string, unknown>
): Promise<NotionToolResponse> {
  try {
    return await callNotionToolOnce(tool, args);
  } catch (error) {
    if (!isRecoverableTransportError(error)) {
      throw error;
    }

    await resetClient();
    return await callNotionToolOnce(tool, args);
  }
}

export interface NotionSchema {
  [propertyName: string]: "title" | "rich_text" | "url" | "number" | "select";
}

/** Create a new Notion database under the configured parent page */
export async function createDatabase(
  title: string,
  schema: NotionSchema
): Promise<string> {
  const parentPageId = getRequiredEnv("NOTION_PARENT_PAGE_ID");

  // Build Notion property definitions from our simple schema
  const properties: Record<string, unknown> = {};

  for (const [name, type] of Object.entries(schema)) {
    if (type === "title") {
      properties[name] = { title: {} };
    } else if (type === "url") {
      properties[name] = { url: {} };
    } else if (type === "number") {
      properties[name] = { number: {} };
    } else if (type === "select") {
      properties[name] = { select: {} };
    } else {
      properties[name] = { rich_text: {} };
    }
  }

  const result = await callNotion("notion_create_database", {
    parent: { page_id: parentPageId },
    title: [{ type: "text", text: { content: title } }],
    properties,
  });
  const database = extractStructuredPayload(result, isRecordWithId);

  if (database) {
    return database.id;
  }

  throw new Error("Could not extract database ID from Notion response");
}

/** Add a row to an existing Notion database */
function buildDuplicateFilter(
  data: Record<string, string>,
  schema: NotionSchema
): Record<string, unknown> | null {
  const filters = Object.entries(data)
    .map(([key, value]) => {
      const trimmedValue = value.trim();
      const type = schema[key];

      if (!type || !trimmedValue) {
        return null;
      }

      if (type === "title") {
        return { property: key, title: { equals: trimmedValue } };
      }

      if (type === "rich_text") {
        return { property: key, rich_text: { equals: trimmedValue } };
      }

      if (type === "url") {
        return { property: key, url: { equals: trimmedValue } };
      }

      if (type === "number") {
        const parsed = Number(trimmedValue);
        return Number.isFinite(parsed) ? { property: key, number: { equals: parsed } } : null;
      }

      if (type === "select") {
        return { property: key, select: { equals: trimmedValue } };
      }

      return null;
    })
    .filter(Boolean) as Record<string, unknown>[];

  if (filters.length === 0) {
    return null;
  }

  return filters.length === 1 ? filters[0] : { and: filters };
}

async function getDataSourceId(databaseId: string): Promise<string> {
  const cached = dataSourceIdCache.get(databaseId);

  if (cached) {
    return cached;
  }

  const result = await callNotion("notion_retrieve_database", { database_id: databaseId });
  const database = extractStructuredPayload(result, isDatabaseWithDataSources);
  const dataSourceId = database?.data_sources[0]?.id;

  if (!dataSourceId) {
    throw new Error(`Could not resolve a data source ID for database "${databaseId}".`);
  }

  dataSourceIdCache.set(databaseId, dataSourceId);
  return dataSourceId;
}

async function findExistingRow(
  databaseId: string,
  data: Record<string, string>,
  schema: NotionSchema
): Promise<boolean> {
  const filter = buildDuplicateFilter(data, schema);

  if (!filter) {
    return false;
  }

  const dataSourceId = await getDataSourceId(databaseId);
  const result = await callNotion("notion_query_data_source", {
    data_source_id: dataSourceId,
    filter,
    page_size: 1,
  });
  const queryResult = extractStructuredPayload(result, isQueryResult);

  return Boolean(queryResult?.results.some(isRecordWithId));
}

export async function addRow(
  databaseId: string,
  data: Record<string, string>,
  schema: NotionSchema
): Promise<{ created: boolean }> {
  if (await findExistingRow(databaseId, data, schema)) {
    return { created: false };
  }

  const properties: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const type = schema[key];
    if (!type || !value) continue;

    if (type === "title") {
      properties[key] = { title: [{ text: { content: value } }] };
    } else if (type === "url") {
      properties[key] = { url: value };
    } else if (type === "number") {
      properties[key] = { number: parseFloat(value) || 0 };
    } else if (type === "select") {
      properties[key] = { select: { name: value } };
    } else {
      properties[key] = { rich_text: [{ text: { content: value } }] };
    }
  }

  await callNotion("notion_create_page", {
    parent: { database_id: databaseId },
    properties,
  });

  return { created: true };
}

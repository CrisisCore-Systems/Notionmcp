import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createRequire } from "node:module";
import type { ResearchItem } from "@/lib/research-result";

let mcpClient: Client | null = null;
let mcpTransport: Transport | null = null;
const require = createRequire(import.meta.url);
const dataSourceIdCache = new Map<string, string>();
const TOOL_NAME_ALIASES: Record<string, string[]> = {
  notion_create_database: ["create-a-data-source", "API-create-a-data-source", "notion_create_database"],
  notion_create_page: ["post-page", "API-post-page", "notion_create_page"],
  notion_retrieve_database: ["retrieve-a-database", "API-retrieve-a-database", "notion_retrieve_database"],
  notion_query_data_source: ["query-data-source", "API-query-data-source", "notion_query_data_source"],
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
  has_more?: boolean;
  next_cursor?: string | null;
}

type NotionTransportFactory = () => Transport;

export interface DuplicateTracker {
  has(data: ResearchItem): boolean;
  remember(data: ResearchItem): void;
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

function parseOpenApiHeaders(value: string | undefined): Record<string, string> {
  if (!value?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
        .map(([key, headerValue]) => [key, headerValue.trim()])
        .filter(([, headerValue]) => headerValue.length > 0)
    );
  } catch {
    return {};
  }
}

function buildNotionMcpEnv(notionToken: string): Record<string, string> {
  const headers = parseOpenApiHeaders(process.env.OPENAPI_MCP_HEADERS);
  const notionApiVersion = process.env.NOTION_API_VERSION?.trim();
  const mergedHeaders = {
    ...headers,
    Authorization: headers.Authorization || `Bearer ${notionToken}`,
    ...(notionApiVersion ? { "Notion-Version": notionApiVersion } : {}),
  };

  return Object.fromEntries(
    Object.entries({
      ...process.env,
      NOTION_TOKEN: notionToken,
      ...(Object.keys(headers).length > 0 || notionApiVersion
        ? { OPENAPI_MCP_HEADERS: JSON.stringify(mergedHeaders) }
        : {}),
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

const notionTransportFactory: NotionTransportFactory = () => {
  const notionToken = getRequiredEnv("NOTION_TOKEN");

  return new StdioClientTransport({
    command: process.execPath,
    args: [getNotionMcpCommand()],
    env: buildNotionMcpEnv(notionToken),
  });
};

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
  const transport = notionTransportFactory();

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

function normalizeDuplicateText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeDuplicateUrl(value: string): string {
  try {
    const url = new URL(value.trim());

    url.hash = "";
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase();

    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }

    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    }

    return url.toString();
  } catch {
    return normalizeDuplicateText(value);
  }
}

function getIdentityPropertyNames(schema: NotionSchema): string[] {
  const preferred = Object.entries(schema)
    .filter(([, type]) => type === "title" || type === "url")
    .map(([name]) => name);

  if (preferred.length > 0) {
    return preferred;
  }

  return Object.entries(schema)
    .filter(([, type]) => type === "select" || type === "number" || type === "rich_text")
    .map(([name]) => name);
}

export function buildDuplicateFingerprint(
  data: ResearchItem,
  schema: NotionSchema
): string | null {
  const parts = getIdentityPropertyNames(schema)
    .map((key) => {
      const type = schema[key];
      const rawValue = data[key];
      const trimmedValue = typeof rawValue === "string" ? rawValue.trim() : "";

      if (!type || !trimmedValue) {
        return null;
      }

      if (type === "url") {
        return `${key}:url:${normalizeDuplicateUrl(trimmedValue)}`;
      }

      if (type === "number") {
        const parsed = Number(trimmedValue);
        return Number.isFinite(parsed) ? `${key}:number:${parsed}` : null;
      }

      return `${key}:${type}:${normalizeDuplicateText(trimmedValue)}`;
    })
    .filter((value): value is string => Boolean(value));

  if (parts.length === 0) {
    return null;
  }

  return parts.join("||");
}

function extractPlainText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((entry) => {
      if (!isRecord(entry)) {
        return "";
      }

      if (typeof entry.plain_text === "string") {
        return entry.plain_text;
      }

      const text = entry.text;
      return isRecord(text) && typeof text.content === "string" ? text.content : "";
    })
    .join("")
    .trim();
}

function getPagePropertyValue(
  page: unknown,
  propertyName: string,
  type: NotionSchema[string]
): string {
  if (!isRecord(page)) {
    return "";
  }

  const properties = page.properties;

  if (!isRecord(properties)) {
    return "";
  }

  const property = properties[propertyName];

  if (!isRecord(property)) {
    return "";
  }

  if (type === "title") {
    return extractPlainText(property.title);
  }

  if (type === "rich_text") {
    return extractPlainText(property.rich_text);
  }

  if (type === "url") {
    return typeof property.url === "string" ? property.url.trim() : "";
  }

  if (type === "number") {
    return typeof property.number === "number" ? String(property.number) : "";
  }

  const select = property.select;
  return isRecord(select) && typeof select.name === "string" ? select.name.trim() : "";
}

function buildDuplicateFingerprintFromPage(
  page: unknown,
  schema: NotionSchema
): string | null {
  const identityData: Record<string, string> = {};

  for (const propertyName of getIdentityPropertyNames(schema)) {
    identityData[propertyName] = getPagePropertyValue(page, propertyName, schema[propertyName]);
  }

  return buildDuplicateFingerprint(identityData, schema);
}

async function getExistingDuplicateFingerprints(
  databaseId: string,
  schema: NotionSchema
): Promise<Set<string>> {
  const dataSourceId = await getDataSourceId(databaseId);
  const fingerprints = new Set<string>();
  let nextCursor: string | null | undefined = undefined;

  do {
    const result = await callNotion("notion_query_data_source", {
      data_source_id: dataSourceId,
      page_size: 100,
      ...(nextCursor ? { start_cursor: nextCursor } : {}),
    });
    const queryResult = extractStructuredPayload(result, isQueryResult);

    for (const row of queryResult?.results ?? []) {
      const fingerprint = buildDuplicateFingerprintFromPage(row, schema);

      if (fingerprint) {
        fingerprints.add(fingerprint);
      }
    }

    nextCursor = queryResult?.has_more ? queryResult.next_cursor ?? null : null;
  } while (nextCursor);
  return fingerprints;
}

export async function createDuplicateTracker(
  databaseId: string,
  schema: NotionSchema,
  options?: { prefetchExisting?: boolean }
): Promise<DuplicateTracker> {
  const fingerprints =
    options?.prefetchExisting === false
      ? new Set<string>()
      : await getExistingDuplicateFingerprints(databaseId, schema);

  return {
    has(data) {
      const fingerprint = buildDuplicateFingerprint(data, schema);
      return fingerprint ? fingerprints.has(fingerprint) : false;
    },
    remember(data) {
      const fingerprint = buildDuplicateFingerprint(data, schema);

      if (fingerprint) {
        fingerprints.add(fingerprint);
      }
    },
  };
}

export async function addRow(
  databaseId: string,
  data: ResearchItem,
  schema: NotionSchema,
  duplicateTracker?: DuplicateTracker
): Promise<{ created: boolean }> {
  if (duplicateTracker?.has(data)) {
    return { created: false };
  }

  const properties: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const type = schema[key];
    if (!type || typeof value !== "string" || !value) continue;

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

  duplicateTracker?.remember(data);
  return { created: true };
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createRequire } from "node:module";
import {
  DEFAULT_NOTION_QUEUE_AUDIT_LOCATOR_PROPERTY,
  DEFAULT_NOTION_QUEUE_CLAIMED_AT_PROPERTY,
  DEFAULT_NOTION_QUEUE_CLAIMED_BY_PROPERTY,
  DEFAULT_NOTION_QUEUE_COMPETITORS_PROPERTY,
  DEFAULT_NOTION_QUEUE_CONFIDENCE_NOTE_PROPERTY,
  DEFAULT_NOTION_QUEUE_ERROR_VALUE,
  DEFAULT_NOTION_QUEUE_EVIDENCE_BLOCK_PROPERTY,
  DEFAULT_NOTION_QUEUE_IN_PROGRESS_VALUE,
  DEFAULT_NOTION_QUEUE_LAST_RESEARCHED_AT_PROPERTY,
  DEFAULT_NOTION_QUEUE_LAST_RUN_STATUS_PROPERTY,
  DEFAULT_NOTION_QUEUE_NEEDS_REVIEW_VALUE,
  DEFAULT_NOTION_QUEUE_PACKET_READY_VALUE,
  DEFAULT_NOTION_QUEUE_RECOMMENDED_DIRECTION_PROPERTY,
  DEFAULT_NOTION_QUEUE_RESEARCH_SUMMARY_PROPERTY,
  DEFAULT_NOTION_QUEUE_RUN_ID_PROPERTY,
  DEFAULT_NOTION_QUEUE_SOURCE_COUNT_PROPERTY,
  buildResearchPromptFromNotionQueueItem,
  type NotionQueueConfig,
} from "@/lib/notion-queue";
import type {
  DuplicateTracker,
  NotionSchema,
  NotionWriteMetadataSupport,
} from "@/lib/notion/provider";
import { enforceNotionValueLimit, isValidHttpUrl } from "@/lib/notion-validation";
import {
  RESEARCH_RUN_METADATA_KEY,
  type ResearchItem,
  type ResearchNotionQueueMetadata,
  type ResearchResult,
} from "@/lib/research-result";
import type { RowWriteMetadata } from "@/lib/write-audit";

let mcpClient: Client | null = null;
let mcpTransport: Transport | null = null;
const require = createRequire(import.meta.url);
const dataSourceIdCache = new Map<string, string>();
export const DEFAULT_NOTION_API_VERSION = "2025-09-03";
const TOOL_NAME_ALIASES: Record<string, string[]> = {
  notion_create_database: ["create-a-data-source", "API-create-a-data-source", "notion_create_database"],
  notion_create_page: ["post-page", "API-post-page", "notion_create_page"],
  notion_update_page: ["patch-page", "API-patch-page", "notion_update_page"],
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

interface NotionDatabasePropertyRecord {
  type: string;
}

interface NotionDatabaseRecord extends NotionDataSourceRecord {
  properties?: Record<string, NotionDatabasePropertyRecord>;
}

interface NotionQueryResult {
  results: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

type NotionQueueWritablePropertyType =
  | "title"
  | "rich_text"
  | "url"
  | "number"
  | "select"
  | "status"
  | "date";

type ClaimedNotionQueueEntry = ResearchNotionQueueMetadata & {
  prompt: string;
};

type QueueLifecycleStage = "in-progress" | "needs-review" | "packet-ready" | "error";

type QueueLifecycleUpdateInput = {
  stage: QueueLifecycleStage;
  result?: ResearchResult;
  auditUrl?: string;
  jobId?: string;
  message?: string;
  occurredAt?: string;
};

type NotionTransportFactory = () => Transport;
type NotionMcpLaunchSpec = {
  command: string;
  args: string[];
};

export const NOTION_ROW_METADATA_PROPERTIES = {
  operationKey: "Operator Operation Key",
  sourceSet: "Operator Source Set",
  confidenceScore: "Operator Confidence",
  evidenceSummary: "Operator Evidence Summary",
} as const;

const FULL_NOTION_WRITE_METADATA_SUPPORT: NotionWriteMetadataSupport = {
  operationKey: true,
  sourceSet: true,
  confidenceScore: true,
  evidenceSummary: true,
};
const NOTION_QUEUE_WRITABLE_PROPERTY_TYPES = [
  "title",
  "rich_text",
  "url",
  "number",
  "select",
  "status",
  "date",
] as const satisfies readonly NotionQueueWritablePropertyType[];

export const notionQueueTestOverrides: {
  claimNextNotionQueueEntry?: (
    input: NotionQueueConfig,
    options: { runId: string; claimedBy: string }
  ) => Promise<ClaimedNotionQueueEntry>;
  updateNotionQueueLifecycle?: (
    entry: ResearchNotionQueueMetadata,
    update: QueueLifecycleUpdateInput
  ) => Promise<void>;
} = {};

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

function parseNotionMcpArgs(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function getNotionMcpLaunchSpec(env: NodeJS.ProcessEnv = process.env): NotionMcpLaunchSpec {
  const command = env.NOTION_MCP_COMMAND?.trim();

  if (command) {
    return {
      command,
      args: parseNotionMcpArgs(env.NOTION_MCP_ARGS),
    };
  }

  return {
    command: process.execPath,
    args: [getNotionMcpCommand()],
  };
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

export function buildNotionMcpEnv(notionToken: string): Record<string, string> {
  const headers = parseOpenApiHeaders(process.env.OPENAPI_MCP_HEADERS);
  const notionApiVersion =
    process.env.NOTION_API_VERSION?.trim() ||
    headers["Notion-Version"]?.trim() ||
    DEFAULT_NOTION_API_VERSION;
  const mergedHeaders = {
    ...headers,
    Authorization: headers.Authorization || `Bearer ${notionToken}`,
    "Notion-Version": notionApiVersion,
  };

  return Object.fromEntries(
    Object.entries({
      ...process.env,
      NOTION_TOKEN: notionToken,
      OPENAPI_MCP_HEADERS: JSON.stringify(mergedHeaders),
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

const notionTransportFactory: NotionTransportFactory = () => {
  const notionToken = getRequiredEnv("NOTION_TOKEN");
  const launchSpec = getNotionMcpLaunchSpec();

  return new StdioClientTransport({
    command: launchSpec.command,
    args: launchSpec.args,
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

function isDatabasePropertyRecord(value: unknown): value is NotionDatabasePropertyRecord {
  return isRecord(value) && typeof value.type === "string";
}

function isDatabaseRecord(value: unknown): value is NotionDatabaseRecord {
  if (!isDatabaseWithDataSources(value) || !isRecord(value)) {
    return false;
  }

  const properties = value.properties;

  return (
    properties === undefined ||
    (isRecord(properties) && Object.values(properties).every(isDatabasePropertyRecord))
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

export function buildOperationalSchema(schema: NotionSchema): NotionSchema {
  return {
    ...schema,
    [NOTION_ROW_METADATA_PROPERTIES.operationKey]: "rich_text",
    [NOTION_ROW_METADATA_PROPERTIES.sourceSet]: "rich_text",
    [NOTION_ROW_METADATA_PROPERTIES.confidenceScore]: "number",
    [NOTION_ROW_METADATA_PROPERTIES.evidenceSummary]: "rich_text",
  };
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

export async function getDatabaseMetadataSupport(
  databaseId: string
): Promise<NotionWriteMetadataSupport> {
  const result = await callNotion("notion_retrieve_database", { database_id: databaseId });
  const database = extractStructuredPayload(result, isDatabaseRecord);
  const properties = database?.properties ?? {};

  return {
    operationKey: properties[NOTION_ROW_METADATA_PROPERTIES.operationKey]?.type === "rich_text",
    sourceSet: properties[NOTION_ROW_METADATA_PROPERTIES.sourceSet]?.type === "rich_text",
    confidenceScore: properties[NOTION_ROW_METADATA_PROPERTIES.confidenceScore]?.type === "number",
    evidenceSummary: properties[NOTION_ROW_METADATA_PROPERTIES.evidenceSummary]?.type === "rich_text",
  };
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

function getPagePropertyText(page: unknown, propertyName: string): string {
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

  const type = typeof property.type === "string" ? property.type : "";

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

  if (type === "select") {
    const select = property.select;
    return isRecord(select) && typeof select.name === "string" ? select.name.trim() : "";
  }

  if (type === "status") {
    const status = property.status;
    return isRecord(status) && typeof status.name === "string" ? status.name.trim() : "";
  }

  return "";
}

function getPagePropertyType(page: unknown, propertyName: string): NotionQueueWritablePropertyType | null {
  if (!isRecord(page)) {
    return null;
  }

  const properties = page.properties;

  if (!isRecord(properties)) {
    return null;
  }

  const property = properties[propertyName];

  if (!isRecord(property) || typeof property.type !== "string") {
    return null;
  }

  return NOTION_QUEUE_WRITABLE_PROPERTY_TYPES.includes(property.type as NotionQueueWritablePropertyType)
    ? (property.type as NotionQueueWritablePropertyType)
    : null;
}

function buildQueuePropertyTypeLookup(
  page: unknown,
  statusProperty: string
): Record<string, NotionQueueWritablePropertyType> {
  const propertyNames = [
    statusProperty,
    DEFAULT_NOTION_QUEUE_CLAIMED_AT_PROPERTY,
    DEFAULT_NOTION_QUEUE_CLAIMED_BY_PROPERTY,
    DEFAULT_NOTION_QUEUE_RUN_ID_PROPERTY,
    DEFAULT_NOTION_QUEUE_LAST_RESEARCHED_AT_PROPERTY,
    DEFAULT_NOTION_QUEUE_RESEARCH_SUMMARY_PROPERTY,
    DEFAULT_NOTION_QUEUE_RECOMMENDED_DIRECTION_PROPERTY,
    DEFAULT_NOTION_QUEUE_COMPETITORS_PROPERTY,
    DEFAULT_NOTION_QUEUE_SOURCE_COUNT_PROPERTY,
    DEFAULT_NOTION_QUEUE_LAST_RUN_STATUS_PROPERTY,
    DEFAULT_NOTION_QUEUE_AUDIT_LOCATOR_PROPERTY,
    DEFAULT_NOTION_QUEUE_EVIDENCE_BLOCK_PROPERTY,
    DEFAULT_NOTION_QUEUE_CONFIDENCE_NOTE_PROPERTY,
  ];
  const lookup: Record<string, NotionQueueWritablePropertyType> = {};

  for (const propertyName of propertyNames) {
    const propertyType = getPagePropertyType(page, propertyName);

    if (propertyType) {
      lookup[propertyName] = propertyType;
    }
  }

  return lookup;
}

function getQueuePropertyType(
  entry: ResearchNotionQueueMetadata,
  propertyName: string
): NotionQueueWritablePropertyType | undefined {
  const propertyType = entry.propertyTypes?.[propertyName];

  return NOTION_QUEUE_WRITABLE_PROPERTY_TYPES.includes(propertyType as NotionQueueWritablePropertyType)
    ? (propertyType as NotionQueueWritablePropertyType)
    : undefined;
}

function formatCompetitorList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function buildNotionQueueRecommendedDirection(result: ResearchResult): string {
  const topCompetitors = result.items
    .map((item) => (typeof item.Name === "string" ? item.Name.trim() : ""))
    .filter(Boolean)
    .slice(0, 3);

  if (topCompetitors.length === 0) {
    return "Review the researched packet and decide whether to proceed with the current direction.";
  }

  if (topCompetitors.length === 1) {
    return `Review ${topCompetitors[0]} as the best-supported direction from this research packet.`;
  }

  return `Review ${formatCompetitorList(topCompetitors)} as the best-supported directions from this packet.`;
}

function buildNotionQueueCompetitors(result: ResearchResult): string {
  return result.items
    .map((item) => (typeof item.Name === "string" ? item.Name.trim() : ""))
    .filter(Boolean)
    .slice(0, 8)
    .join(", ");
}

function buildNotionQueueEvidenceBlock(result: ResearchResult): string {
  const runMetadata = result[RESEARCH_RUN_METADATA_KEY];
  const strongestSources = runMetadata?.search?.sourceQuality?.strongestSourceUrls ?? [];
  const topSources = [...strongestSources, ...(runMetadata?.sourceSet ?? [])]
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url, index, list) => list.indexOf(url) === index)
    .slice(0, 3);
  const sourceCount = runMetadata?.sourceSet.length ?? topSources.length;

  if (topSources.length === 0 && sourceCount === 0) {
    return "";
  }

  const lines = [`Top sources (${topSources.length}/${sourceCount}):`, ...topSources.map((url, index) => `${index + 1}. ${url}`)];
  return lines.join("\n");
}

function buildNotionQueueConfidenceNote(result: ResearchResult): string {
  const runMetadata = result[RESEARCH_RUN_METADATA_KEY];
  const mode = runMetadata?.search?.mode ?? "fast";
  const sourceCount = runMetadata?.sourceSet.length ?? 0;
  const averageScore = runMetadata?.search?.sourceQuality?.averageScore;
  const degradedSuffix = runMetadata?.search?.degraded ? " Search degraded gracefully during collection." : "";

  return `Reviewed ${mode} lane packet backed by ${sourceCount} source${
    sourceCount === 1 ? "" : "s"
  }${typeof averageScore === "number" ? ` with average source quality ${averageScore.toFixed(1)}.` : "."}${degradedSuffix}`.trim();
}

function setQueuePropertyValue(
  properties: Record<string, unknown>,
  propertyName: string,
  propertyType: NotionQueueWritablePropertyType | undefined,
  value: string | number | undefined,
  kind: "text" | "number" | "date"
) {
  if (!propertyType || value === undefined || value === "") {
    return;
  }

  if (kind === "number") {
    const normalizedNumber = typeof value === "number" ? value : Number(value);

    if (!Number.isFinite(normalizedNumber)) {
      return;
    }

    if (propertyType === "number") {
      properties[propertyName] = { number: normalizedNumber };
      return;
    }

    value = String(normalizedNumber);
  }

  if (kind === "date" && typeof value === "string") {
    if (propertyType === "date") {
      properties[propertyName] = { date: { start: value } };
      return;
    }
  }

  const textValue = typeof value === "string" ? value : String(value);

  if (!textValue.trim()) {
    return;
  }

  let notionValueType: "title" | "url" | "rich_text" = "rich_text";

  if (propertyType === "title") {
    notionValueType = "title";
  } else if (propertyType === "url") {
    notionValueType = "url";
  }

  const content = enforceNotionValueLimit(textValue, notionValueType);

  if (propertyType === "status") {
    properties[propertyName] = { status: { name: content } };
    return;
  }

  if (propertyType === "select") {
    properties[propertyName] = { select: { name: content } };
    return;
  }

  if (propertyType === "url" && isValidHttpUrl(content)) {
    properties[propertyName] = { url: content };
    return;
  }

  if (propertyType === "title") {
    properties[propertyName] = { title: [{ text: { content } }] };
    return;
  }

  if (propertyType === "number") {
    const normalizedNumber = Number(textValue);

    if (Number.isFinite(normalizedNumber)) {
      properties[propertyName] = { number: normalizedNumber };
    }
    return;
  }

  if (propertyType === "date") {
    properties[propertyName] = { date: { start: textValue } };
    return;
  }

  properties[propertyName] = { rich_text: [{ text: { content } }] };
}

function buildQueueLifecycleProperties(
  entry: ResearchNotionQueueMetadata,
  update: QueueLifecycleUpdateInput
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const occurredAt = update.occurredAt ?? new Date().toISOString();
  const result = update.result;
  const runMetadata = result?.[RESEARCH_RUN_METADATA_KEY];
  const stageStatusValue =
    update.stage === "in-progress"
      ? DEFAULT_NOTION_QUEUE_IN_PROGRESS_VALUE
      : update.stage === "needs-review"
        ? DEFAULT_NOTION_QUEUE_NEEDS_REVIEW_VALUE
        : update.stage === "packet-ready"
          ? DEFAULT_NOTION_QUEUE_PACKET_READY_VALUE
          : DEFAULT_NOTION_QUEUE_ERROR_VALUE;

  setQueuePropertyValue(properties, entry.statusProperty, getQueuePropertyType(entry, entry.statusProperty), stageStatusValue, "text");
  setQueuePropertyValue(
    properties,
    DEFAULT_NOTION_QUEUE_LAST_RUN_STATUS_PROPERTY,
    getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_LAST_RUN_STATUS_PROPERTY),
    update.message ?? stageStatusValue,
    "text"
  );
  setQueuePropertyValue(
    properties,
    DEFAULT_NOTION_QUEUE_AUDIT_LOCATOR_PROPERTY,
    getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_AUDIT_LOCATOR_PROPERTY),
    update.auditUrl ?? update.jobId,
    "text"
  );

  if (update.stage === "in-progress") {
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_CLAIMED_AT_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_CLAIMED_AT_PROPERTY),
      occurredAt,
      "date"
    );
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_CLAIMED_BY_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_CLAIMED_BY_PROPERTY),
      entry.claimedBy,
      "text"
    );
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_RUN_ID_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_RUN_ID_PROPERTY),
      entry.runId,
      "text"
    );
    return properties;
  }

  if (result) {
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_LAST_RESEARCHED_AT_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_LAST_RESEARCHED_AT_PROPERTY),
      occurredAt,
      "date"
    );
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_RESEARCH_SUMMARY_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_RESEARCH_SUMMARY_PROPERTY),
      result.summary,
      "text"
    );
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_RECOMMENDED_DIRECTION_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_RECOMMENDED_DIRECTION_PROPERTY),
      buildNotionQueueRecommendedDirection(result),
      "text"
    );
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_COMPETITORS_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_COMPETITORS_PROPERTY),
      buildNotionQueueCompetitors(result),
      "text"
    );
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_SOURCE_COUNT_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_SOURCE_COUNT_PROPERTY),
      runMetadata?.sourceSet.length ?? 0,
      "number"
    );
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_EVIDENCE_BLOCK_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_EVIDENCE_BLOCK_PROPERTY),
      buildNotionQueueEvidenceBlock(result),
      "text"
    );
    setQueuePropertyValue(
      properties,
      DEFAULT_NOTION_QUEUE_CONFIDENCE_NOTE_PROPERTY,
      getQueuePropertyType(entry, DEFAULT_NOTION_QUEUE_CONFIDENCE_NOTE_PROPERTY),
      buildNotionQueueConfidenceNote(result),
      "text"
    );
  }

  return properties;
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

function getOperationKeyFromPage(page: unknown): string {
  return getPagePropertyValue(page, NOTION_ROW_METADATA_PROPERTIES.operationKey, "rich_text");
}

async function getExistingDuplicateRecords(
  databaseId: string,
  schema: NotionSchema
): Promise<{ fingerprints: Set<string>; operationKeys: Set<string> }> {
  const dataSourceId = await getDataSourceId(databaseId);
  const fingerprints = new Set<string>();
  const operationKeys = new Set<string>();
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
      const operationKey = getOperationKeyFromPage(row);

      if (fingerprint) {
        fingerprints.add(fingerprint);
      }

      if (operationKey) {
        operationKeys.add(operationKey);
      }
    }

    nextCursor = queryResult?.has_more ? queryResult.next_cursor ?? null : null;
  } while (nextCursor);
  return { fingerprints, operationKeys };
}

const OPERATION_KEY_LOOKUP_BATCH_SIZE = 25;

async function getExistingOperationKeys(
  databaseId: string,
  operationKeys: string[]
): Promise<Set<string>> {
  const dataSourceId = await getDataSourceId(databaseId);
  const uniqueOperationKeys = Array.from(
    new Set(operationKeys.map((operationKey) => operationKey.trim()).filter(Boolean))
  );
  const existingOperationKeys = new Set<string>();

  for (let index = 0; index < uniqueOperationKeys.length; index += OPERATION_KEY_LOOKUP_BATCH_SIZE) {
    const batch = uniqueOperationKeys.slice(index, index + OPERATION_KEY_LOOKUP_BATCH_SIZE);
    const result = await callNotion("notion_query_data_source", {
      data_source_id: dataSourceId,
      page_size: batch.length,
      filter: {
        or: batch.map((operationKey) => ({
          property: NOTION_ROW_METADATA_PROPERTIES.operationKey,
          rich_text: {
            equals: operationKey,
          },
        })),
      },
    });
    const queryResult = extractStructuredPayload(result, isQueryResult);

    for (const row of queryResult?.results ?? []) {
      const existingOperationKey = getOperationKeyFromPage(row);

      if (existingOperationKey) {
        existingOperationKeys.add(existingOperationKey);
      }
    }
  }

  return existingOperationKeys;
}

export async function createDuplicateTracker(
  databaseId: string,
  schema: NotionSchema,
  options?: { prefetchExisting?: boolean; useOperationKeyLookup?: boolean; operationKeys?: string[] }
): Promise<DuplicateTracker> {
  const records =
    options?.prefetchExisting === false
      ? { fingerprints: new Set<string>(), operationKeys: new Set<string>() }
      : await getExistingDuplicateRecords(databaseId, schema);

  if (options?.useOperationKeyLookup) {
    const existingOperationKeys = await getExistingOperationKeys(databaseId, options.operationKeys ?? []);

    for (const operationKey of existingOperationKeys) {
      records.operationKeys.add(operationKey);
    }
  }

  return {
    has(data, operationKey) {
      if (operationKey && records.operationKeys.has(operationKey)) {
        return true;
      }

      const fingerprint = buildDuplicateFingerprint(data, schema);
      return fingerprint ? records.fingerprints.has(fingerprint) : false;
    },
    remember(data, operationKey) {
      const fingerprint = buildDuplicateFingerprint(data, schema);

      if (fingerprint) {
        records.fingerprints.add(fingerprint);
      }

      if (operationKey) {
        records.operationKeys.add(operationKey);
      }
    },
  };
}

export async function loadNextNotionQueueEntry(input: NotionQueueConfig): Promise<{
  pageId: string;
  title: string;
  prompt: string;
}> {
  const dataSourceId = await getDataSourceId(input.databaseId);
  const expectedReadyValue = input.readyValue.trim().toLowerCase();
  let nextCursor: string | null | undefined = undefined;

  do {
    const result = await callNotion("notion_query_data_source", {
      data_source_id: dataSourceId,
      page_size: 25,
      ...(nextCursor ? { start_cursor: nextCursor } : {}),
    });
    const queryResult = extractStructuredPayload(result, isQueryResult);

    for (const row of queryResult?.results ?? []) {
      if (!isRecordWithId(row)) {
        continue;
      }

      const status = getPagePropertyText(row, input.statusProperty);

      if (expectedReadyValue && status.trim().toLowerCase() !== expectedReadyValue) {
        continue;
      }

      const title = getPagePropertyText(row, input.titleProperty);
      const prompt = buildResearchPromptFromNotionQueueItem({
        title,
        prompt: getPagePropertyText(row, input.promptProperty),
      });

      if (!prompt) {
        continue;
      }

      return {
        pageId: row.id,
        title,
        prompt,
      };
    }

    nextCursor = queryResult?.has_more ? queryResult.next_cursor ?? null : null;
  } while (nextCursor);

  throw new Error("No ready Notion queue items with a usable research prompt were found.");
}

export async function claimNextNotionQueueEntry(
  input: NotionQueueConfig,
  options: { runId: string; claimedBy: string }
): Promise<ClaimedNotionQueueEntry> {
  if (notionQueueTestOverrides.claimNextNotionQueueEntry) {
    return await notionQueueTestOverrides.claimNextNotionQueueEntry(input, options);
  }

  const dataSourceId = await getDataSourceId(input.databaseId);
  const expectedReadyValue = input.readyValue.trim().toLowerCase();
  let nextCursor: string | null | undefined = undefined;

  do {
    const result = await callNotion("notion_query_data_source", {
      data_source_id: dataSourceId,
      page_size: 25,
      ...(nextCursor ? { start_cursor: nextCursor } : {}),
    });
    const queryResult = extractStructuredPayload(result, isQueryResult);

    for (const row of queryResult?.results ?? []) {
      if (!isRecordWithId(row)) {
        continue;
      }

      const status = getPagePropertyText(row, input.statusProperty);

      if (expectedReadyValue && status.trim().toLowerCase() !== expectedReadyValue) {
        continue;
      }

      const title = getPagePropertyText(row, input.titleProperty);
      const prompt = buildResearchPromptFromNotionQueueItem({
        title,
        prompt: getPagePropertyText(row, input.promptProperty),
      });

      if (!prompt) {
        continue;
      }

      const entry: ClaimedNotionQueueEntry = {
        databaseId: input.databaseId,
        pageId: row.id,
        title,
        prompt,
        statusProperty: input.statusProperty,
        runId: options.runId,
        claimedBy: options.claimedBy,
        propertyTypes: buildQueuePropertyTypeLookup(row, input.statusProperty),
      };

      await updateNotionQueueLifecycle(entry, {
        stage: "in-progress",
        jobId: options.runId,
        message: DEFAULT_NOTION_QUEUE_IN_PROGRESS_VALUE,
      });

      return entry;
    }

    nextCursor = queryResult?.has_more ? queryResult.next_cursor ?? null : null;
  } while (nextCursor);

  throw new Error("No ready Notion queue items with a usable research prompt were found.");
}

export async function updateNotionQueueLifecycle(
  entry: ResearchNotionQueueMetadata,
  update: QueueLifecycleUpdateInput
): Promise<void> {
  if (notionQueueTestOverrides.updateNotionQueueLifecycle) {
    await notionQueueTestOverrides.updateNotionQueueLifecycle(entry, update);
    return;
  }

  const properties = buildQueueLifecycleProperties(entry, update);

  if (Object.keys(properties).length === 0) {
    return;
  }

  await callNotion("notion_update_page", {
    page_id: entry.pageId,
    properties,
  });
}

export async function addRow(
  databaseId: string,
  data: ResearchItem,
  schema: NotionSchema,
  duplicateTracker?: DuplicateTracker,
  writeMetadata?: RowWriteMetadata,
  metadataSupport: NotionWriteMetadataSupport = FULL_NOTION_WRITE_METADATA_SUPPORT
): Promise<{ created: boolean }> {
  if (duplicateTracker?.has(data, writeMetadata?.operationKey)) {
    return { created: false };
  }

  const properties = buildNotionPageProperties(data, schema, writeMetadata, metadataSupport);

  await callNotion("notion_create_page", {
    parent: { database_id: databaseId },
    properties,
  });

  duplicateTracker?.remember(data, writeMetadata?.operationKey);
  return { created: true };
}

export function buildNotionPageProperties(
  data: ResearchItem,
  schema: NotionSchema,
  writeMetadata?: RowWriteMetadata,
  metadataSupport: NotionWriteMetadataSupport = FULL_NOTION_WRITE_METADATA_SUPPORT
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const type = schema[key];
    if (!type || typeof value !== "string" || !value) continue;

    if (type === "title") {
      properties[key] = { title: [{ text: { content: enforceNotionValueLimit(value, type) } }] };
    } else if (type === "url") {
      const urlValue = enforceNotionValueLimit(value, type);

      if (!urlValue || !isValidHttpUrl(urlValue)) {
        continue;
      }

      properties[key] = { url: urlValue };
    } else if (type === "number") {
      const numberValue = Number(value);

      if (!Number.isFinite(numberValue)) {
        throw new Error(`Invalid numeric value for "${key}".`);
      }

      properties[key] = { number: numberValue };
    } else if (type === "select") {
      properties[key] = { select: { name: value } };
    } else {
      properties[key] = { rich_text: [{ text: { content: enforceNotionValueLimit(value, type) } }] };
    }
  }

  if (writeMetadata?.operationKey && metadataSupport.operationKey) {
    properties[NOTION_ROW_METADATA_PROPERTIES.operationKey] = {
      rich_text: [{ text: { content: enforceNotionValueLimit(writeMetadata.operationKey, "rich_text") } }],
    };
  }

  if (writeMetadata?.sourceSet && metadataSupport.sourceSet) {
    properties[NOTION_ROW_METADATA_PROPERTIES.sourceSet] = {
      rich_text: [{ text: { content: enforceNotionValueLimit(writeMetadata.sourceSet, "rich_text") } }],
    };
  }

  if (writeMetadata && metadataSupport.confidenceScore) {
    properties[NOTION_ROW_METADATA_PROPERTIES.confidenceScore] = {
      number: writeMetadata.confidenceScore,
    };
  }

  if (writeMetadata?.evidenceSummary && metadataSupport.evidenceSummary) {
    properties[NOTION_ROW_METADATA_PROPERTIES.evidenceSummary] = {
      rich_text: [{ text: { content: enforceNotionValueLimit(writeMetadata.evidenceSummary, "rich_text") } }],
    };
  }

  return properties;
}

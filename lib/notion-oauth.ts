import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { NextRequest, NextResponse } from "next/server";
import { isInlineOnlyHost } from "@/lib/deployment-boundary";
import { DEFAULT_NOTION_API_VERSION } from "@/lib/notion/domain";
import { readPersistedStateFile, writePersistedStateFile } from "@/lib/persisted-state";
import { decryptSessionValue, encryptSessionValue } from "@/lib/session-crypto";

const NOTION_OAUTH_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_OAUTH_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_CONNECTION_RETENTION_ENV_VAR = "NOTION_CONNECTION_RETENTION_DAYS";

export const NOTION_OAUTH_STATE_COOKIE_NAME = "notionmcp-notion-oauth-state";
export const ACTIVE_NOTION_CONNECTION_COOKIE_NAME = "notionmcp-active-notion-connection";
export const ACTIVE_NOTION_CONNECTION_RECORD_COOKIE_NAME = "notionmcp-active-notion-connection-record";

const notionConnectionCache = new Map<string, NotionConnectionRecord>();

export type NotionOAuthConfigurationStatus = {
  configured: boolean;
  missingEnvVars: string[];
};

export type NotionConnectionRecord = {
  connectionId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string | null;
  botId: string;
  accessToken: string;
  source: "oauth";
  owner: {
    type: string;
    userId: string | null;
    userName: string | null;
    avatarUrl: string | null;
  };
  connectedAt: string;
  updatedAt: string;
};

type SafeNotionConnection = Omit<NotionConnectionRecord, "accessToken">;

export type NotionDiscoveredDatabaseProperty = {
  name: string;
  type: string;
};

export type NotionDiscoveredDatabase = {
  databaseId: string;
  title: string;
  url: string | null;
  description: string;
  lastEditedTime: string | null;
  dataSourceId: string | null;
  properties: NotionDiscoveredDatabaseProperty[];
  suggestedQueueProperties: {
    promptProperty: string | null;
    titleProperty: string | null;
    statusProperty: string | null;
  };
};

export type NotionDiscoveredParentPage = {
  pageId: string;
  title: string;
  url: string | null;
  lastEditedTime: string | null;
  parentType: string | null;
};

type NotionSearchResponse = {
  results?: unknown;
};

type NotionDatabaseResponse = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  description?: unknown;
  last_edited_time?: unknown;
  data_sources?: unknown;
  properties?: unknown;
};

type NotionPageSearchResponse = {
  id?: unknown;
  url?: unknown;
  last_edited_time?: unknown;
  parent?: unknown;
  properties?: unknown;
};

type NotionOAuthTokenResponse = {
  access_token?: unknown;
  workspace_id?: unknown;
  workspace_name?: unknown;
  workspace_icon?: unknown;
  bot_id?: unknown;
  owner?: unknown;
};

function getNotionConnectionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NOTION_CONNECTION_DIR?.trim();
  return configured || path.join(process.cwd(), ".notionmcp-data", "notion-connections");
}

function getNotionConnectionPath(connectionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getNotionConnectionDirectory(env), `${encodeURIComponent(connectionId)}.json`);
}

function getRequiredOAuthEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  const required = ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET", "NOTION_OAUTH_REDIRECT_URI"] as const;
  return required.filter((name) => !env[name]?.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getNullableString(value: unknown): string | null {
  const normalized = getTrimmedString(value);
  return normalized || null;
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

function getNotionApiHeaders(accessToken: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers = parseOpenApiHeaders(env.OPENAPI_MCP_HEADERS);
  const notionApiVersion =
    env.NOTION_API_VERSION?.trim() ||
    headers["Notion-Version"]?.trim() ||
    DEFAULT_NOTION_API_VERSION;

  return {
    ...headers,
    Authorization: headers.Authorization || `Bearer ${accessToken}`,
    "Notion-Version": notionApiVersion,
    "Content-Type": "application/json",
  };
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

function normalizePropertyName(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").replaceAll(/\s+/g, " ").trim();
}

function getDatabaseProperties(value: unknown): NotionDiscoveredDatabaseProperty[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .map(([name, property]) => ({
      name,
      type: isRecord(property) ? getTrimmedString(property.type) || "unknown" : "unknown",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function extractPageTitleFromProperties(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }

  for (const property of Object.values(value)) {
    if (!isRecord(property) || property.type !== "title") {
      continue;
    }

    const title = extractPlainText(property.title);

    if (title) {
      return title;
    }
  }

  return "";
}

function findSuggestedProperty(
  properties: NotionDiscoveredDatabaseProperty[],
  options: {
    exactNames: string[];
    containsNames: string[];
    allowedTypes: string[];
  }
): string | null {
  const normalizedExactNames = options.exactNames.map(normalizePropertyName);
  const normalizedContainsNames = options.containsNames.map(normalizePropertyName);
  const allowedTypes = new Set(options.allowedTypes);
  const candidates = properties.filter((property) => allowedTypes.has(property.type));

  for (const exactName of normalizedExactNames) {
    const match = candidates.find((property) => normalizePropertyName(property.name) === exactName);

    if (match) {
      return match.name;
    }
  }

  for (const containsName of normalizedContainsNames) {
    const match = candidates.find((property) => normalizePropertyName(property.name).includes(containsName));

    if (match) {
      return match.name;
    }
  }

  return candidates[0]?.name ?? null;
}

function buildSuggestedQueueProperties(properties: NotionDiscoveredDatabaseProperty[]) {
  return {
    promptProperty: findSuggestedProperty(properties, {
      exactNames: ["Research Prompt", "Prompt", "Brief"],
      containsNames: ["research prompt", "prompt", "brief", "request", "description", "notes"],
      allowedTypes: ["rich_text", "title"],
    }),
    titleProperty: findSuggestedProperty(properties, {
      exactNames: ["Name", "Title"],
      containsNames: ["name", "title", "task"],
      allowedTypes: ["title"],
    }),
    statusProperty: findSuggestedProperty(properties, {
      exactNames: ["Status", "Stage", "State"],
      containsNames: ["status", "stage", "state"],
      allowedTypes: ["status", "select"],
    }),
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

async function notionRequest<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const extraHeaders = init?.headers ?? undefined;
  const response = await fetchImpl(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      ...getNotionApiHeaders(accessToken, env),
      ...extraHeaders,
    },
    cache: "no-store",
  });
  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string"
      ? payload.message
      : JSON.stringify(payload);
    throw new Error(`Notion discovery request failed with HTTP status ${response.status}: ${message}`);
  }

  return payload as T;
}

function toDiscoveredDatabase(base: unknown, details: unknown): NotionDiscoveredDatabase | null {
  const baseRecord = isRecord(base) ? base : null;
  const detailRecord = isRecord(details) ? details : null;
  const databaseId = getTrimmedString(detailRecord?.id ?? baseRecord?.id);

  if (!databaseId) {
    return null;
  }

  const properties = getDatabaseProperties(detailRecord?.properties);
  const dataSources = Array.isArray(detailRecord?.data_sources) ? detailRecord.data_sources : [];
  const dataSourceId = dataSources.find((entry) => isRecord(entry) && typeof entry.id === "string")?.id ?? null;

  return {
    databaseId,
    title:
      extractPlainText(detailRecord?.title) ||
      extractPlainText(baseRecord?.title) ||
      databaseId,
    url: getNullableString(detailRecord?.url ?? baseRecord?.url),
    description: extractPlainText(detailRecord?.description ?? baseRecord?.description),
    lastEditedTime: getNullableString(detailRecord?.last_edited_time ?? baseRecord?.last_edited_time),
    dataSourceId: getNullableString(dataSourceId),
    properties,
    suggestedQueueProperties: buildSuggestedQueueProperties(properties),
  };
}

function toDiscoveredParentPage(value: unknown): NotionDiscoveredParentPage | null {
  const page = isRecord(value) ? value : null;
  const pageId = getTrimmedString(page?.id);

  if (!pageId) {
    return null;
  }

  const parent = isRecord(page?.parent) ? page.parent : null;

  return {
    pageId,
    title: extractPageTitleFromProperties(page?.properties) || pageId,
    url: getNullableString(page?.url),
    lastEditedTime: getNullableString(page?.last_edited_time),
    parentType: getNullableString(parent?.type),
  };
}

function parseOwner(owner: unknown): NotionConnectionRecord["owner"] {
  if (!isRecord(owner)) {
    return {
      type: "unknown",
      userId: null,
      userName: null,
      avatarUrl: null,
    };
  }

  const user = isRecord(owner.user) ? owner.user : null;
  return {
    type: getTrimmedString(owner.type) || "unknown",
    userId: getNullableString(user?.id),
    userName: getNullableString(user?.name),
    avatarUrl: getNullableString(user?.avatar_url),
  };
}

function toConnectionRecord(payload: NotionOAuthTokenResponse): NotionConnectionRecord {
  const accessToken = getTrimmedString(payload.access_token);
  const workspaceId = getTrimmedString(payload.workspace_id);
  const botId = getTrimmedString(payload.bot_id);

  if (!accessToken || !workspaceId || !botId) {
    throw new Error("Notion OAuth response was missing the access token, workspace ID, or bot ID.");
  }

  const now = new Date().toISOString();
  const workspaceName = getTrimmedString(payload.workspace_name) || workspaceId;

  return {
    connectionId: workspaceId,
    workspaceId,
    workspaceName,
    workspaceIcon: getNullableString(payload.workspace_icon),
    botId,
    accessToken,
    source: "oauth",
    owner: parseOwner(payload.owner),
    connectedAt: now,
    updatedAt: now,
  };
}

export function getNotionOAuthConfigurationStatus(
  env: NodeJS.ProcessEnv = process.env
): NotionOAuthConfigurationStatus {
  const missingEnvVars = getRequiredOAuthEnvVars(env);
  return {
    configured: missingEnvVars.length === 0,
    missingEnvVars,
  };
}

export function getNotionOAuthConfigurationError(env: NodeJS.ProcessEnv = process.env): string | null {
  const status = getNotionOAuthConfigurationStatus(env);

  if (status.configured) {
    return null;
  }

  return `Notion OAuth is not configured. Missing: ${status.missingEnvVars.join(", ")}.`;
}

export function buildNotionOAuthAuthorizationUrl(state: string, env: NodeJS.ProcessEnv = process.env): string {
  const clientId = env.NOTION_CLIENT_ID?.trim();
  const redirectUri = env.NOTION_OAUTH_REDIRECT_URI?.trim();

  if (!clientId || !redirectUri) {
    throw new Error(getNotionOAuthConfigurationError(env) ?? "Notion OAuth is not configured.");
  }

  const url = new URL(NOTION_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeNotionOAuthCode(
  code: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<NotionConnectionRecord> {
  const clientId = env.NOTION_CLIENT_ID?.trim();
  const clientSecret = env.NOTION_CLIENT_SECRET?.trim();
  const redirectUri = env.NOTION_OAUTH_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(getNotionOAuthConfigurationError(env) ?? "Notion OAuth is not configured.");
  }

  const authorization = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const response = await fetch(NOTION_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
    cache: "no-store",
  });

  const rawBody = await response.text();
  let payload: unknown = {};

  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const errorPayload = isRecord(payload) ? payload : null;
    const errorMessage = errorPayload?.["message"];
    const message = typeof errorMessage === "string"
      ? errorMessage
      : rawBody || `Notion OAuth token exchange failed with status ${response.status}.`;
    throw new Error(message);
  }

  return toConnectionRecord(payload as NotionOAuthTokenResponse);
}

export async function persistNotionConnection(
  record: NotionConnectionRecord,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  notionConnectionCache.set(record.connectionId, record);

  if (isInlineOnlyHost(env)) {
    return;
  }

  await writePersistedStateFile(
    getNotionConnectionPath(record.connectionId, env),
    record,
    NOTION_CONNECTION_RETENTION_ENV_VAR,
    env
  );
}

export async function loadNotionConnection(
  connectionId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<NotionConnectionRecord | null> {
  const cached = notionConnectionCache.get(connectionId.trim());

  if (cached) {
    return cached;
  }

  try {
    const record = await readPersistedStateFile<NotionConnectionRecord>(
      getNotionConnectionPath(connectionId, env),
      NOTION_CONNECTION_RETENTION_ENV_VAR,
      env
    );

    notionConnectionCache.set(record.connectionId, record);
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function listNotionConnections(
  env: NodeJS.ProcessEnv = process.env
): Promise<NotionConnectionRecord[]> {
  if (isInlineOnlyHost(env)) {
    return [...notionConnectionCache.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  try {
    const entries = await readdir(getNotionConnectionDirectory(env), { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && path.extname(entry.name) === ".json")
        .map(async (entry) => {
          const connectionId = decodeURIComponent(path.basename(entry.name, ".json"));
          return await loadNotionConnection(connectionId, env);
        })
    );

    return records
      .filter((record): record is NotionConnectionRecord => Boolean(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function clearNotionConnection(connectionId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  notionConnectionCache.delete(connectionId.trim());

  if (isInlineOnlyHost(env)) {
    return;
  }

  try {
    await unlink(getNotionConnectionPath(connectionId, env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function getNotionConnectionStatus(
  activeConnectionId: string | null,
  envOrActiveConnection?: NodeJS.ProcessEnv | NotionConnectionRecord | null,
  maybeActiveConnection?: NotionConnectionRecord | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  oauth: NotionOAuthConfigurationStatus;
  activeConnection: SafeNotionConnection | null;
  savedConnections: SafeNotionConnection[];
}> {
  const resolvedEnv = isNotionConnectionRecordCandidate(envOrActiveConnection) ? env : (envOrActiveConnection ?? env);
  const explicitActiveConnection = isNotionConnectionRecordCandidate(envOrActiveConnection)
    ? envOrActiveConnection
    : maybeActiveConnection;
  const savedConnections = (await listNotionConnections(resolvedEnv)).map(stripAccessToken);
  const mergedConnections = explicitActiveConnection
    ? [stripAccessToken(explicitActiveConnection), ...savedConnections.filter((record) => record.connectionId !== explicitActiveConnection.connectionId)]
    : savedConnections;
  let activeConnection: SafeNotionConnection | null = null;

  if (explicitActiveConnection) {
    activeConnection = stripAccessToken(explicitActiveConnection);
  } else if (activeConnectionId) {
    activeConnection = mergedConnections.find((record) => record.connectionId === activeConnectionId) ?? null;
  }

  return {
    oauth: getNotionOAuthConfigurationStatus(resolvedEnv),
    activeConnection,
    savedConnections: mergedConnections,
  };
}

export async function listAccessibleNotionDatabases(
  activeConnectionId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<NotionDiscoveredDatabase[]> {
  const connection = await loadNotionConnection(activeConnectionId, env);

  if (!connection) {
    throw new Error(`No saved Notion connection was found for connection "${activeConnectionId}".`);
  }

  const searchPayload = await notionRequest<NotionSearchResponse>(
    connection.accessToken,
    "/search",
    {
      method: "POST",
      body: JSON.stringify({
        page_size: 25,
        filter: {
          property: "object",
          value: "database",
        },
        sort: {
          direction: "descending",
          timestamp: "last_edited_time",
        },
      }),
    },
    env,
    fetchImpl
  );

  const searchResults = Array.isArray(searchPayload.results) ? searchPayload.results : [];
  const databases = await Promise.all(
    searchResults.map(async (entry) => {
      const entryRecord = isRecord(entry) ? entry : null;
      const databaseId = getTrimmedString(entryRecord?.id);

      if (!databaseId) {
        return null;
      }

      const details = await notionRequest<NotionDatabaseResponse>(
        connection.accessToken,
        `/databases/${encodeURIComponent(databaseId)}`,
        undefined,
        env,
        fetchImpl
      );

      return toDiscoveredDatabase(entry, details);
    })
  );

  return databases.filter((database): database is NotionDiscoveredDatabase => Boolean(database));
}

export async function listAccessibleNotionParentPages(
  activeConnectionId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<NotionDiscoveredParentPage[]> {
  const connection = await loadNotionConnection(activeConnectionId, env);

  if (!connection) {
    throw new Error(`No saved Notion connection was found for connection "${activeConnectionId}".`);
  }

  const searchPayload = await notionRequest<NotionSearchResponse>(
    connection.accessToken,
    "/search",
    {
      method: "POST",
      body: JSON.stringify({
        page_size: 25,
        filter: {
          property: "object",
          value: "page",
        },
        sort: {
          direction: "descending",
          timestamp: "last_edited_time",
        },
      }),
    },
    env,
    fetchImpl
  );

  const searchResults = Array.isArray(searchPayload.results) ? searchPayload.results : [];

  return searchResults
    .map((entry) => toDiscoveredParentPage(entry as NotionPageSearchResponse))
    .filter((page): page is NotionDiscoveredParentPage => Boolean(page));
}

export function createNotionOAuthState(): string {
  return randomUUID();
}

export function stripAccessToken(
  record: NotionConnectionRecord
): SafeNotionConnection {
  const safeRecord = { ...record };
  delete safeRecord.accessToken;
  return safeRecord;
}

function isNotionConnectionRecordCandidate(
  value: NodeJS.ProcessEnv | NotionConnectionRecord | null | undefined
): value is NotionConnectionRecord {
  return value !== null && value !== undefined && typeof value === "object" && "connectionId" in value;
}

export function readActiveNotionConnectionRecord(
  serialized: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): NotionConnectionRecord | null {
  const record = decryptSessionValue<NotionConnectionRecord>(serialized, env);

  if (!record?.connectionId || !record.accessToken) {
    return null;
  }

  notionConnectionCache.set(record.connectionId, record);
  return record;
}

export function getActiveNotionConnectionFromRequest(
  req: NextRequest,
  env: NodeJS.ProcessEnv = process.env
): NotionConnectionRecord | null {
  return readActiveNotionConnectionRecord(
    req.cookies.get(ACTIVE_NOTION_CONNECTION_RECORD_COOKIE_NAME)?.value,
    env
  );
}

export function setActiveNotionConnectionCookies(
  response: NextResponse,
  connection: NotionConnectionRecord,
  secure: boolean,
  env: NodeJS.ProcessEnv = process.env
): void {
  notionConnectionCache.set(connection.connectionId, connection);
  response.cookies.set({
    name: ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
    value: connection.connectionId,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  response.cookies.set({
    name: ACTIVE_NOTION_CONNECTION_RECORD_COOKIE_NAME,
    value: encryptSessionValue(connection, env),
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearActiveNotionConnectionCookies(response: NextResponse): void {
  response.cookies.delete(ACTIVE_NOTION_CONNECTION_COOKIE_NAME);
  response.cookies.delete(ACTIVE_NOTION_CONNECTION_RECORD_COOKIE_NAME);
}
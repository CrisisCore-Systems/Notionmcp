import {
  buildDuplicateFingerprint,
  buildNotionPageProperties,
  DEFAULT_NOTION_API_VERSION,
  NOTION_ROW_METADATA_PROPERTIES,
} from "@/lib/notion-mcp";
import type {
  DuplicateTracker,
  NotionProvider,
  NotionSchema,
  NotionWriteMetadataSupport,
} from "@/lib/notion/provider";

const DEFAULT_NOTION_API_BASE_URL = "https://api.notion.com/v1";
const OPERATION_KEY_LOOKUP_BATCH_SIZE = 25;

type DirectApiProviderConfig = {
  apiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

type NotionDatabasePropertyRecord = {
  type: string;
};

type NotionDatabaseRecord = {
  id: string;
  data_sources?: Array<{ id: string }>;
};

type NotionDataSourceRecord = {
  id: string;
  properties?: Record<string, NotionDatabasePropertyRecord>;
};

type NotionQueryResult = {
  results: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
};

const FULL_NOTION_WRITE_METADATA_SUPPORT: NotionWriteMetadataSupport = {
  operationKey: true,
  sourceSet: true,
  confidenceScore: true,
  evidenceSummary: true,
};

function getRequiredEnv(
  env: NodeJS.ProcessEnv,
  name: "NOTION_TOKEN" | "NOTION_PARENT_PAGE_ID"
): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and set the required Notion credentials.`
    );
  }

  return value;
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

function getNotionApiHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const notionToken = getRequiredEnv(env, "NOTION_TOKEN");
  const headers = parseOpenApiHeaders(env.OPENAPI_MCP_HEADERS);
  const notionApiVersion =
    env.NOTION_API_VERSION?.trim() ||
    headers["Notion-Version"]?.trim() ||
    DEFAULT_NOTION_API_VERSION;

  return {
    ...headers,
    Authorization: headers.Authorization || `Bearer ${notionToken}`,
    "Notion-Version": notionApiVersion,
    "Content-Type": "application/json",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function getOperationKeyFromPage(page: unknown): string {
  return getPagePropertyValue(page, NOTION_ROW_METADATA_PROPERTIES.operationKey, "rich_text");
}

function buildDuplicateFingerprintFromPage(
  page: unknown,
  schema: NotionSchema
): string | null {
  const identityData: Record<string, string> = {};

  for (const propertyName of Object.keys(schema)) {
    identityData[propertyName] = getPagePropertyValue(page, propertyName, schema[propertyName]);
  }

  return buildDuplicateFingerprint(identityData, schema);
}

function buildDatabaseProperties(schema: NotionSchema): Record<string, unknown> {
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

  return properties;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export function createDirectApiNotionProvider(
  config: DirectApiProviderConfig = {}
): NotionProvider {
  const env = config.env ?? process.env;
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_NOTION_API_BASE_URL).replace(/\/+$/, "");
  const dataSourceIdCache = new Map<string, string>();

  async function notionRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...getNotionApiHeaders(env),
        ...(init?.headers ?? {}),
      },
    });
    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.message === "string" ? payload.message : JSON.stringify(payload);
      throw new Error(`Notion direct API request failed with HTTP status ${response.status}: ${message}`);
    }

    return payload as T;
  }

  async function getDataSourceId(databaseId: string): Promise<string> {
    const cached = dataSourceIdCache.get(databaseId);

    if (cached) {
      return cached;
    }

    const database = await notionRequest<NotionDatabaseRecord>(`/databases/${databaseId}`);
    const dataSourceId = database.data_sources?.[0]?.id;

    if (!dataSourceId) {
      throw new Error(`Could not resolve a data source ID for database "${databaseId}".`);
    }

    dataSourceIdCache.set(databaseId, dataSourceId);
    return dataSourceId;
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
      const queryResult: NotionQueryResult = await notionRequest(`/data_sources/${dataSourceId}/query`, {
        method: "POST",
        body: JSON.stringify({
          page_size: 100,
          ...(nextCursor ? { start_cursor: nextCursor } : {}),
        }),
      });

      for (const row of queryResult.results ?? []) {
        const fingerprint = buildDuplicateFingerprintFromPage(row, schema);
        const operationKey = getOperationKeyFromPage(row);

        if (fingerprint) {
          fingerprints.add(fingerprint);
        }

        if (operationKey) {
          operationKeys.add(operationKey);
        }
      }

      nextCursor = queryResult.has_more ? queryResult.next_cursor ?? null : null;
    } while (nextCursor);

    return { fingerprints, operationKeys };
  }

  async function getExistingOperationKeys(
    databaseId: string,
    operationKeys: string[]
  ): Promise<Set<string>> {
    const dataSourceId = await getDataSourceId(databaseId);
    const uniqueOperationKeys = Array.from(new Set(operationKeys.map((entry) => entry.trim()).filter(Boolean)));
    const existingOperationKeys = new Set<string>();

    for (let index = 0; index < uniqueOperationKeys.length; index += OPERATION_KEY_LOOKUP_BATCH_SIZE) {
      const batch = uniqueOperationKeys.slice(index, index + OPERATION_KEY_LOOKUP_BATCH_SIZE);
      const queryResult = await notionRequest<NotionQueryResult>(`/data_sources/${dataSourceId}/query`, {
        method: "POST",
        body: JSON.stringify({
          page_size: batch.length,
          filter: {
            or: batch.map((operationKey) => ({
              property: NOTION_ROW_METADATA_PROPERTIES.operationKey,
              rich_text: {
                equals: operationKey,
              },
            })),
          },
        }),
      });

      for (const row of queryResult.results ?? []) {
        const existingOperationKey = getOperationKeyFromPage(row);

        if (existingOperationKey) {
          existingOperationKeys.add(existingOperationKey);
        }
      }
    }

    return existingOperationKeys;
  }

  return {
    async createDatabase(input) {
      const parentPageId = getRequiredEnv(env, "NOTION_PARENT_PAGE_ID");
      const database = await notionRequest<{ id?: string }>("/databases", {
        method: "POST",
        body: JSON.stringify({
          parent: { type: "page_id", page_id: parentPageId },
          title: [{ type: "text", text: { content: input.title } }],
          initial_data_source: {
            properties: buildDatabaseProperties(input.schema),
          },
        }),
      });

      if (!database.id) {
        throw new Error("Could not extract database ID from Notion response");
      }

      return { databaseId: database.id };
    },
    async getDatabaseMetadataSupport(databaseId) {
      const dataSourceId = await getDataSourceId(databaseId);
      const dataSource = await notionRequest<NotionDataSourceRecord>(`/data_sources/${dataSourceId}`);
      const properties = dataSource.properties ?? {};

      return {
        operationKey: properties[NOTION_ROW_METADATA_PROPERTIES.operationKey]?.type === "rich_text",
        sourceSet: properties[NOTION_ROW_METADATA_PROPERTIES.sourceSet]?.type === "rich_text",
        confidenceScore: properties[NOTION_ROW_METADATA_PROPERTIES.confidenceScore]?.type === "number",
        evidenceSummary: properties[NOTION_ROW_METADATA_PROPERTIES.evidenceSummary]?.type === "rich_text",
      };
    },
    async queryExistingRows(input) {
      const records =
        input.options?.prefetchExisting === false
          ? { fingerprints: new Set<string>(), operationKeys: new Set<string>() }
          : await getExistingDuplicateRecords(input.databaseId, input.schema);

      if (input.options?.useOperationKeyLookup) {
        const existingOperationKeys = await getExistingOperationKeys(
          input.databaseId,
          input.options.operationKeys ?? []
        );

        for (const operationKey of existingOperationKeys) {
          records.operationKeys.add(operationKey);
        }
      }

      const tracker: DuplicateTracker = {
        has(data, operationKey) {
          if (operationKey && records.operationKeys.has(operationKey)) {
            return true;
          }

          const fingerprint = buildDuplicateFingerprint(data, input.schema);
          return fingerprint ? records.fingerprints.has(fingerprint) : false;
        },
        remember(data, operationKey) {
          const fingerprint = buildDuplicateFingerprint(data, input.schema);

          if (fingerprint) {
            records.fingerprints.add(fingerprint);
          }

          if (operationKey) {
            records.operationKeys.add(operationKey);
          }
        },
      };

      return tracker;
    },
    async createPage(input) {
      const metadataSupport = input.metadataSupport ?? FULL_NOTION_WRITE_METADATA_SUPPORT;

      if (input.duplicateTracker?.has(input.data, input.writeMetadata?.operationKey)) {
        return { created: false };
      }

      const dataSourceId = await getDataSourceId(input.databaseId);

      await notionRequest("/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { type: "data_source_id", data_source_id: dataSourceId },
          properties: buildNotionPageProperties(
            input.data,
            input.schema,
            input.writeMetadata,
            metadataSupport
          ),
        }),
      });

      input.duplicateTracker?.remember(input.data, input.writeMetadata?.operationKey);
      return { created: true };
    },
  };
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";

let mcpClient: Client | null = null;
const NOTION_API_VERSION = "2022-06-28";
const require = createRequire(import.meta.url);

interface NotionToolResponse {
  content?: unknown;
  structuredContent?: unknown;
}

interface NotionRecordWithId {
  id: string;
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

  await mcpClient.connect(transport);
  return mcpClient;
}

/** Call any Notion MCP tool by name */
export async function callNotion(
  tool: string,
  args: Record<string, unknown>
): Promise<NotionToolResponse> {
  const client = await getClient();
  const result = await client.callTool({ name: tool, arguments: args });

  if (result.isError) {
    throw new Error(`Notion MCP error on "${tool}": ${JSON.stringify(result.content)}`);
  }

  return {
    content: result.content,
    structuredContent: "structuredContent" in result ? result.structuredContent : undefined,
  };
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

  const result = (await callNotion("notion_create_database", {
    parent: { page_id: parentPageId },
    title: [{ type: "text", text: { content: title } }],
    properties,
  }));
  const database = extractStructuredPayload(result, isRecordWithId);

  if (database) {
    return database.id;
  }

  throw new Error("Could not extract database ID from Notion response");
}

/** Add a row to an existing Notion database */
export async function addRow(
  databaseId: string,
  data: Record<string, string>,
  schema: NotionSchema
): Promise<void> {
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
}

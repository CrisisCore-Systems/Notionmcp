import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient: Client | null = null;

/** Lazily start and connect to the Notion MCP server subprocess */
async function getClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: {
      ...process.env,
      // Notion MCP server reads auth from this header string
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
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
): Promise<unknown> {
  const client = await getClient();
  const result = await client.callTool({ name: tool, arguments: args });

  if (result.isError) {
    throw new Error(`Notion MCP error on "${tool}": ${JSON.stringify(result.content)}`);
  }

  return result.content;
}

export interface NotionSchema {
  [propertyName: string]: "title" | "rich_text" | "url" | "number" | "select";
}

/** Create a new Notion database under the configured parent page */
export async function createDatabase(
  title: string,
  schema: NotionSchema
): Promise<string> {
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
    parent: { page_id: process.env.NOTION_PARENT_PAGE_ID },
    title: [{ type: "text", text: { content: title } }],
    properties,
  })) as { id?: string }[];

  // Extract the database ID from the response
  const content = result[0] as { text?: string };
  const text = content?.text ?? "";
  const match = text.match(/"id":\s*"([a-f0-9-]{36})"/);
  if (match) return match[1];

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

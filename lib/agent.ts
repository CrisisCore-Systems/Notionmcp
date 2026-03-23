import {
  GoogleGenerativeAI,
  SchemaType,
  FunctionCallingMode,
  type FunctionDeclaration,
} from "@google/generative-ai";
import { browseAndExtract, searchWeb } from "./browser";
import { mapWithConcurrencyLimit } from "./concurrency";
import type { ResearchResult } from "./research-result";
import { parseResearchResult } from "./write-payload";

export type { ResearchResult } from "./research-result";

/** Create a Gemini client or throw a setup error if the API key is missing. */
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY. Copy .env.example to .env.local and set your Gemini API key."
    );
  }

  return new GoogleGenerativeAI(apiKey);
}
const MAX_ITERATIONS = 15;
const MAX_PARALLEL_TOOL_CALLS = 2;

const SYSTEM_PROMPT = `You are a research agent that browses the web and structures findings into a Notion database.

Given a research prompt, you will:
1. Use search_web to find relevant pages
2. Use browse_url to extract detailed information from each page
3. Compile findings into structured rows

Tool responses may fail. Failed tool responses will include {"ok": false, "error": {...}}. Treat those as failures, not as source material.

When you have gathered enough data (at least 3-5 items), respond with ONLY a valid JSON object in this exact format:
{
  "suggestedDbTitle": "Short descriptive title for the Notion database",
  "summary": "2-3 sentence summary of what you found",
  "schema": {
    "Name": "title",
    "URL": "url",
    "Description": "rich_text",
    "Other Field": "rich_text"
  },
  "items": [
    {
      "Name": "...",
      "URL": "...",
      "Description": "...",
      "Other Field": "...",
      "__provenance": {
        "sourceUrls": ["https://example.com/a", "https://example.com/b"],
        "evidenceByField": {
          "Name": ["Short snippet proving the name"],
          "Description": ["Short snippet proving the description"]
        }
      }
    }
  ]
}

Schema property types: "title" (required, one per schema), "rich_text", "url", "number", "select"
Always include a "Name" title field and a "URL" url field when relevant.
Every item must include "__provenance.sourceUrls" with one or more public source URLs used for that row, plus brief evidence snippets when you can support individual fields.
Do not add "__provenance" to the schema. Tailor the schema to the research topic. Be specific and useful.`;

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "search_web",
    description:
      "Search the configured web search provider for a query. Returns page titles, URLs, and snippets. Use this first to find relevant pages.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "browse_url",
    description:
      "Navigate to a specific URL and extract its full text content. Use this to get detailed information from a page found via search.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: {
          type: SchemaType.STRING,
          description: "The full URL to browse",
        },
      },
      required: ["url"],
    },
  },
];

function getToolArgs(args: unknown): { query?: string; url?: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }

  const candidate = args as Record<string, unknown>;

  return {
    query: typeof candidate.query === "string" ? candidate.query : undefined,
    url: typeof candidate.url === "string" ? candidate.url : undefined,
  };
}

export async function runResearchAgent(
  prompt: string,
  onUpdate: (msg: string) => void
): Promise<ResearchResult> {
  const model = getGeminiClient().getGenerativeModel({
    model: "gemini-2.0-flash",
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingMode.AUTO },
    },
    systemInstruction: SYSTEM_PROMPT,
  });

  const chat = model.startChat();
  let response = await chat.sendMessage(prompt);
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const calls = response.response.functionCalls();

    // No more tool calls → final structured response
    if (!calls || calls.length === 0) {
      const text = response.response.text().trim();

      // Strip markdown code fences if present
      const cleaned = text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      try {
        return parseResearchResult(
          JSON.parse(cleaned),
          "Agent returned an invalid research payload."
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`Agent returned non-JSON response: ${text.slice(0, 200)}`);
        }

        throw error;
      }
    }

    // Execute tool calls with a small concurrency limit to avoid overloading browser + upstream services.
    const toolResults = await mapWithConcurrencyLimit(
      calls,
      MAX_PARALLEL_TOOL_CALLS,
      async (call) => {
        const args = getToolArgs(call.args);

        try {
          if (call.name === "search_web") {
            const query = args.query ?? "";
            onUpdate(`🔍 Searching: "${query}"`);
            const results = await searchWeb(query);

            return {
              functionResponse: {
                name: call.name,
                response: {
                  ok: true,
                  result: results,
                },
              },
            };
          }

          if (call.name === "browse_url") {
            const url = args.url ?? "";
            onUpdate(`🌐 Browsing: ${url}`);
            const result = await browseAndExtract(url);

            return {
              functionResponse: {
                name: call.name,
                response: {
                  ok: true,
                  result,
                },
              },
            };
          }

          throw new Error(`Unknown tool: ${call.name}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onUpdate(`⚠️ ${call.name} failed: ${message}`);

          return {
            functionResponse: {
              name: call.name,
              response: {
                ok: false,
                error: {
                  message,
                },
              },
            },
          };
        }
      }
    );

    response = await chat.sendMessage(toolResults);
  }

  throw new Error("Research agent hit max iterations without completing.");
}

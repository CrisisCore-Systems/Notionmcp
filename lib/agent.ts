import {
  GoogleGenerativeAI,
  SchemaType,
  FunctionCallingMode,
  type FunctionDeclaration,
} from "@google/generative-ai";
import { browseAndExtract, searchWeb } from "./browser";
import { mapWithConcurrencyLimit } from "./concurrency";
import { RESEARCH_RUN_METADATA_KEY, type ResearchResult } from "./research-result";
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
const MAX_RECONCILIATION_ATTEMPTS = 1;

type SearchResult = Awaited<ReturnType<typeof searchWeb>>;
type BrowseResult = Awaited<ReturnType<typeof browseAndExtract>>;

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

function buildReconciliationPrompt(previousResponse: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);

  return `Your previous response failed validation: ${reason}

Repair it into a single valid JSON object only.
- Preserve only claims grounded in prior tool outputs.
- Every row must include "__provenance.sourceUrls" with one or more public URLs.
- Every populated row must include "__provenance.evidenceByField" with evidence for the title field and enough evidence coverage to justify the row.
- Prefer structured signals extracted from JSON-LD, Open Graph, tables, and page metadata when available.
- Do not wrap the JSON in markdown fences.

Previous response:
${previousResponse}`;
}

function normalizeModelResponseText(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function countUniqueSourceUrls(result: ResearchResult): number {
  const sourceUrls = new Set<string>();

  for (const item of result.items) {
    for (const url of item.__provenance?.sourceUrls ?? []) {
      if (url) {
        sourceUrls.add(url);
      }
    }
  }

  return sourceUrls.size;
}

function normalizeSearchCacheKey(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeBrowseCacheKey(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url.trim();
  }
}

function getCachedToolResult<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const cached = cache.get(key);

  if (cached) {
    return cached;
  }

  const pending = loader().catch((error) => {
    cache.delete(key);
    throw error;
  });

  cache.set(key, pending);
  return pending;
}

type ParseResearchResponseOptions = {
  maxReconciliationAttempts?: number;
  reconcile?: (repairPrompt: string) => Promise<string>;
  onUpdate?: (msg: string) => void;
  startedAtMs?: number;
};

export async function parseResearchResponseWithReconciliation(
  responseText: string,
  {
    maxReconciliationAttempts = MAX_RECONCILIATION_ATTEMPTS,
    reconcile,
    onUpdate,
    startedAtMs,
  }: ParseResearchResponseOptions = {}
): Promise<ResearchResult> {
  let cleaned = normalizeModelResponseText(responseText);
  let reconciliationAttempts = 0;

  while (true) {
    try {
      const result = parseResearchResult(
        JSON.parse(cleaned),
        "Agent returned an invalid research payload."
      );
      const uniqueSourceCount = countUniqueSourceUrls(result);
      const durationSuffix =
        typeof startedAtMs === "number"
          ? ` in ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`
          : "";
      const reconciliationSuffix =
        reconciliationAttempts > 0
          ? ` after ${reconciliationAttempts} reconciliation attempt${
              reconciliationAttempts === 1 ? "" : "s"
            }`
          : "";

      onUpdate?.(
        `✅ Structured ${result.items.length} row${result.items.length === 1 ? "" : "s"} from ${uniqueSourceCount} unique source${uniqueSourceCount === 1 ? "" : "s"}${reconciliationSuffix}${durationSuffix}.`
      );
      return result;
    } catch (error) {
      if (reconciliationAttempts >= maxReconciliationAttempts || !reconcile) {
        if (error instanceof SyntaxError) {
          throw new Error(`Agent returned non-JSON response: ${cleaned.slice(0, 200)}`);
        }

        throw error;
      }

      reconciliationAttempts += 1;
      onUpdate?.("🧭 Reconciling extracted rows before approval...");
      cleaned = normalizeModelResponseText(
        await reconcile(buildReconciliationPrompt(cleaned, error))
      );
    }
  }
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
  const startedAtMs = Date.now();
  const searchCache = new Map<string, Promise<SearchResult>>();
  const browseCache = new Map<string, Promise<BrowseResult>>();
  const searchQuerySet = new Set<string>();
  const candidateSourceSet = new Set<string>();
  const pagesBrowsedSet = new Set<string>();
  const rejectedUrlSet = new Set<string>();

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const calls = response.response.functionCalls();

    // No more tool calls → final structured response
    if (!calls || calls.length === 0) {
      const result = await parseResearchResponseWithReconciliation(response.response.text(), {
        maxReconciliationAttempts: MAX_RECONCILIATION_ATTEMPTS,
        startedAtMs,
        onUpdate,
        reconcile: async (repairPrompt) => {
          const repairedResponse = await chat.sendMessage(repairPrompt);
          return repairedResponse.response.text();
        },
      });

      const sourceSet = Array.from(
        new Set(
          result.items.flatMap((item) => item.__provenance?.sourceUrls ?? []).filter(Boolean)
        )
      ).sort((left, right) => left.localeCompare(right));

      return {
        ...result,
        [RESEARCH_RUN_METADATA_KEY]: {
          sourceSet,
          extractionCounts: {
            searchQueries: searchQuerySet.size,
            candidateSources: candidateSourceSet.size,
            pagesBrowsed: pagesBrowsedSet.size,
            rowsExtracted: result.items.length,
          },
          rejectedUrls: Array.from(rejectedUrlSet).sort((left, right) => left.localeCompare(right)),
        },
      };
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
            searchQuerySet.add(normalizeSearchCacheKey(query));
            onUpdate(`🔍 Searching: "${query}"`);
            const results = await getCachedToolResult(searchCache, normalizeSearchCacheKey(query), () =>
              searchWeb(query)
            );
            for (const result of results) {
              if (result.url) {
                candidateSourceSet.add(normalizeBrowseCacheKey(result.url));
              }
            }
            onUpdate(
              `📚 Search returned ${results.length} candidate source${results.length === 1 ? "" : "s"}.`
            );

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
            const result = await getCachedToolResult(browseCache, normalizeBrowseCacheKey(url), () =>
              browseAndExtract(url)
            );
            if (result.url) {
              pagesBrowsedSet.add(normalizeBrowseCacheKey(result.url));
            }

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
          if (call.name === "browse_url" && args.url) {
            rejectedUrlSet.add(normalizeBrowseCacheKey(args.url));
          }
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

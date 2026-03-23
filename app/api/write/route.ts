import { NextRequest } from "next/server";
import type { ResearchResult } from "@/lib/agent";
import { addRow, createDatabase, type NotionSchema } from "@/lib/notion-mcp";

export const runtime = "nodejs";
export const maxDuration = 120;

const NOTION_PROPERTY_TYPES = new Set([
  "title",
  "rich_text",
  "url",
  "number",
  "select",
]);
const ROW_WRITE_MAX_ATTEMPTS = 3;
const ROW_WRITE_RETRY_DELAY_MS = 750;

function isValidDatabaseId(value: string): boolean {
  return (
    /^[a-f0-9]{32}$/i.test(value) ||
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getUniquePropertyName(
  requestedName: string,
  existingNames: Set<string>
): string {
  const baseName = requestedName.trim().replace(/\s+/g, " ") || "Field";
  let candidate = baseName;
  let suffix = 2;

  while (existingNames.has(candidate.toLowerCase())) {
    candidate = `${baseName} ${suffix}`;
    suffix += 1;
  }

  existingNames.add(candidate.toLowerCase());
  return candidate;
}

function normalizeTextValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

function normalizeResearchResult(result: ResearchResult): ResearchResult {
  const suggestedDbTitle = result.suggestedDbTitle.trim();
  const summary = result.summary.trim();
  const normalizedSchema: NotionSchema = {};
  const normalizedKeyLookup = new Map<string, string>();
  const seenPropertyNames = new Set<string>();

  for (const [rawName, rawType] of Object.entries(result.schema)) {
    const propertyName = getUniquePropertyName(rawName, seenPropertyNames);

    if (!NOTION_PROPERTY_TYPES.has(rawType)) {
      continue;
    }

    normalizedSchema[propertyName] = rawType;
    normalizedKeyLookup.set(rawName, propertyName);
  }

  const titleFieldCount = Object.values(normalizedSchema).filter((type) => type === "title").length;

  if (!suggestedDbTitle || !summary || titleFieldCount !== 1) {
    throw new Error("A complete research result is required");
  }

  const normalizedItems = result.items
    .map((item, rowIndex) => {
      const normalizedItem: Record<string, string> = {};

      for (const [originalKey, normalizedKey] of normalizedKeyLookup.entries()) {
        const propertyType = normalizedSchema[normalizedKey];
        const rawValue = item[originalKey];
        const value = normalizeTextValue(rawValue);

        if (!propertyType) {
          continue;
        }

        if (!value) {
          normalizedItem[normalizedKey] = "";
          continue;
        }

        if (propertyType === "url" && !isValidHttpUrl(value)) {
          throw new Error(
            `Row ${rowIndex + 1} has an invalid URL "${value}" in "${normalizedKey}".`
          );
        }

        if (propertyType === "number") {
          const numberValue = Number(value);

          if (!Number.isFinite(numberValue)) {
            throw new Error(`Row ${rowIndex + 1} has a non-numeric value in "${normalizedKey}".`);
          }

          normalizedItem[normalizedKey] = String(numberValue);
          continue;
        }

        normalizedItem[normalizedKey] = value;
      }

      return normalizedItem;
    })
    .filter((item) => Object.values(item).some((value) => value.trim().length > 0));

  if (normalizedItems.length === 0) {
    throw new Error("At least one non-empty item is required");
  }

  return {
    suggestedDbTitle,
    summary,
    schema: normalizedSchema,
    items: normalizedItems,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function addRowWithRetry(
  databaseId: string,
  data: Record<string, string>,
  schema: NotionSchema,
  rowIndex: number
): Promise<number> {
  let attempt = 0;

  while (attempt < ROW_WRITE_MAX_ATTEMPTS) {
    attempt += 1;

    try {
      await addRow(databaseId, data, schema);
      return attempt;
    } catch (error) {
      if (attempt >= ROW_WRITE_MAX_ATTEMPTS) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to write row ${rowIndex + 1} after ${ROW_WRITE_MAX_ATTEMPTS} attempts: ${message}`
        );
      }

      await sleep(ROW_WRITE_RETRY_DELAY_MS * attempt);
    }
  }

  return ROW_WRITE_MAX_ATTEMPTS;
}

/** Validate the streamed research payload before writing anything to Notion. */
function isResearchResult(value: unknown): value is ResearchResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const schema = candidate.schema;
  const items = candidate.items;

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }

  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every((item) => item && typeof item === "object" && !Array.isArray(item))
  ) {
    return false;
  }

  return (
    typeof candidate.suggestedDbTitle === "string" &&
    typeof candidate.summary === "string" &&
    Object.values(schema).every(
      (propertyType) =>
        typeof propertyType === "string" && NOTION_PROPERTY_TYPES.has(propertyType)
    )
  );
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as unknown;

  if (!isResearchResult(body)) {
    return new Response(JSON.stringify({ error: "A complete research result is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const candidate = body as unknown as Record<string, unknown>;
  const targetDatabaseId =
    typeof candidate.targetDatabaseId === "string"
      ? candidate.targetDatabaseId.trim()
      : "";
  const resumeFromIndex =
    typeof candidate.resumeFromIndex === "number" ? candidate.resumeFromIndex : 0;

  if (!Number.isInteger(resumeFromIndex) || resumeFromIndex < 0) {
    return new Response(JSON.stringify({ error: "resumeFromIndex must be a non-negative integer" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  let normalizedBody: ResearchResult;

  try {
    normalizedBody = normalizeResearchResult(body);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "A complete research result is required",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  const suggestedDbTitle = normalizedBody.suggestedDbTitle;
  const summary = normalizedBody.summary;
  const schema = normalizedBody.schema;
  const items = normalizedBody.items;

  if (!suggestedDbTitle || !summary) {
    return new Response(JSON.stringify({ error: "A complete research result is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  if (resumeFromIndex > 0 && !targetDatabaseId) {
    return new Response(
      JSON.stringify({ error: "targetDatabaseId is required when resuming a partial write" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  if (resumeFromIndex > items.length) {
    return new Response(
      JSON.stringify({ error: "resumeFromIndex cannot be greater than the number of items" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  if (targetDatabaseId && !isValidDatabaseId(targetDatabaseId)) {
    return new Response(JSON.stringify({ error: "A valid Notion database ID is required" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      let databaseId = targetDatabaseId;
      let nextRowIndex = resumeFromIndex;

      try {
        if (databaseId) {
          send("update", { message: `Using existing Notion database "${databaseId}"...` });
        } else {
          send("update", { message: `Creating Notion database "${suggestedDbTitle}"...` });
          databaseId = await createDatabase(suggestedDbTitle, schema);
        }

        if (resumeFromIndex > 0) {
          send("update", {
            message: `Resuming Notion write from row ${resumeFromIndex + 1} of ${items.length}...`,
          });
        }

        for (let index = resumeFromIndex; index < items.length; index++) {
          nextRowIndex = index;
          const attempt = await addRowWithRetry(databaseId, items[index], schema, index);
          send("update", {
            message:
              attempt > 1
                ? `Added row ${index + 1} of ${items.length} after ${attempt} attempts`
                : `Added row ${index + 1} of ${items.length}`,
          });
        }

        send("complete", {
          databaseId,
          itemsWritten: items.length - resumeFromIndex,
          propertyCount: Object.keys(schema).length,
          usedExistingDatabase: !!targetDatabaseId,
          resumedFromIndex: resumeFromIndex,
          message: targetDatabaseId
            ? `✅ Added ${items.length - resumeFromIndex} row${items.length - resumeFromIndex === 1 ? "" : "s"} to the existing Notion database`
            : `✅ Created Notion database and wrote ${items.length - resumeFromIndex} row${items.length - resumeFromIndex === 1 ? "" : "s"}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        send("error", {
          message,
          databaseId: databaseId || undefined,
          nextRowIndex,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

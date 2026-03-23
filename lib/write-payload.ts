import type { ResearchResult } from "@/lib/agent";
import type { NotionSchema } from "@/lib/notion-mcp";

const NOTION_PROPERTY_TYPES = new Set(["title", "rich_text", "url", "number", "select"]);

export function isValidDatabaseId(value: string): boolean {
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

function getUniquePropertyName(requestedName: string, existingNames: Set<string>): string {
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

export function normalizeResearchResult(result: ResearchResult): ResearchResult {
  const suggestedDbTitle = result.suggestedDbTitle.trim();
  const summary = result.summary.trim();
  const normalizedSchema: NotionSchema = {};
  const normalizedKeyLookup = new Map<string, string>();
  const seenPropertyNames = new Set<string>();

  for (const [rawName, rawType] of Object.entries(result.schema)) {
    if (!NOTION_PROPERTY_TYPES.has(rawType)) {
      throw new Error(`Unsupported schema type "${rawType}" for "${rawName}".`);
    }

    const propertyName = getUniquePropertyName(rawName, seenPropertyNames);

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

export function isResearchResult(value: unknown): value is ResearchResult {
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

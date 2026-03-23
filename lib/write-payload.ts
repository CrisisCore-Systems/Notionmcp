import type { NotionSchema } from "@/lib/notion-mcp";
import {
  RESEARCH_ITEM_PROVENANCE_KEY,
  type ResearchItem,
  type ResearchItemProvenance,
  type ResearchResult,
} from "@/lib/research-result";

const NOTION_PROPERTY_TYPES = new Set(["title", "rich_text", "url", "number", "select"]);
const MIN_EVIDENCE_DENSITY = 0.5;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();

  return value
    .map((entry) => normalizeTextValue(entry))
    .filter((entry) => {
      if (!entry || !isValidHttpUrl(entry) || seen.has(entry)) {
        return false;
      }

      seen.add(entry);
      return true;
    });
}

function normalizeEvidenceByField(
  value: unknown,
  normalizedKeyLookup?: Map<string, string>
): Record<string, string[]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(value)
      .map(([fieldName, fieldEvidence]) => [
        normalizedKeyLookup?.get(fieldName) ?? normalizeTextValue(fieldName),
        Array.isArray(fieldEvidence)
          ? fieldEvidence
              .map((entry) => normalizeTextValue(entry))
              .filter(Boolean)
              .slice(0, 5)
          : [],
      ])
      .filter(([fieldName, fieldEvidence]) => fieldName && fieldEvidence.length > 0)
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProvenanceForSchema(
  value: unknown,
  normalizedKeyLookup: Map<string, string>
): ResearchItemProvenance | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceUrls = normalizeSourceUrls(value.sourceUrls);
  const evidenceByField = normalizeEvidenceByField(value.evidenceByField, normalizedKeyLookup);

  if (sourceUrls.length === 0 && !evidenceByField) {
    return undefined;
  }

  return {
    ...(sourceUrls.length > 0 ? { sourceUrls } : { sourceUrls: [] }),
    ...(evidenceByField ? { evidenceByField } : {}),
  };
}

function getPopulatedFieldNames(item: ResearchItem, schema: NotionSchema): string[] {
  return Object.entries(schema)
    .filter(([key, type]) => type !== "url" && typeof item[key] === "string" && item[key].trim().length > 0)
    .map(([key]) => key);
}

function hasAnyPopulatedValue(item: ResearchItem, schema: NotionSchema): boolean {
  return Object.keys(schema).some(
    (key) => typeof item[key] === "string" && item[key].trim().length > 0
  );
}

function validateItemProvenance(
  item: ResearchItem,
  schema: NotionSchema,
  rowIndex: number
): ResearchItemProvenance {
  const provenance = item[RESEARCH_ITEM_PROVENANCE_KEY];

  if (!provenance || typeof provenance !== "object") {
    throw new Error(`Row ${rowIndex + 1} is missing provenance.`);
  }

  const normalizedProvenance = provenance as ResearchItemProvenance;
  const sourceUrls = normalizeSourceUrls(normalizedProvenance.sourceUrls);

  if (sourceUrls.length === 0) {
    throw new Error(`Row ${rowIndex + 1} must include at least one provenance source URL.`);
  }

  const evidenceByField = normalizeEvidenceByField(normalizedProvenance.evidenceByField);

  if (!evidenceByField) {
    throw new Error(`Row ${rowIndex + 1} must include field-level evidence snippets.`);
  }

  const titleField = Object.entries(schema).find(([, type]) => type === "title")?.[0];
  const populatedFields = getPopulatedFieldNames(item, schema);
  const evidencedFields = populatedFields.filter((fieldName) => (evidenceByField[fieldName] ?? []).length > 0);
  const minimumEvidenceFields = Math.max(
    1,
    Math.ceil(populatedFields.length * MIN_EVIDENCE_DENSITY)
  );

  if (titleField && populatedFields.includes(titleField) && !evidenceByField[titleField]?.length) {
    throw new Error(`Row ${rowIndex + 1} must include evidence for "${titleField}".`);
  }

  if (evidencedFields.length < minimumEvidenceFields) {
    throw new Error(
      `Row ${rowIndex + 1} needs denser evidence coverage before approval.`
    );
  }

  return {
    sourceUrls,
    evidenceByField,
  };
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
      const normalizedItem: ResearchItem = {};

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

      const provenance = normalizeProvenanceForSchema(
        item[RESEARCH_ITEM_PROVENANCE_KEY],
        normalizedKeyLookup
      );

      if (provenance) {
        normalizedItem[RESEARCH_ITEM_PROVENANCE_KEY] = provenance;
      }

      if (hasAnyPopulatedValue(normalizedItem, normalizedSchema)) {
        normalizedItem[RESEARCH_ITEM_PROVENANCE_KEY] = validateItemProvenance(
          normalizedItem,
          normalizedSchema,
          rowIndex
        );
      }

      return normalizedItem;
    })
    .filter((item) =>
      Object.entries(item).some(
        ([key, value]) =>
          key !== RESEARCH_ITEM_PROVENANCE_KEY &&
          typeof value === "string" &&
          value.trim().length > 0
      )
    );

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

export function parseResearchResult(
  value: unknown,
  fallbackMessage = "A complete research result is required"
): ResearchResult {
  if (!isResearchResult(value)) {
    throw new Error(fallbackMessage);
  }

  return normalizeResearchResult(value);
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

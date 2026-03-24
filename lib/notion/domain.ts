import type { NotionSchema, NotionWriteMetadataSupport } from "@/lib/notion/provider";
import type { ResearchItem } from "@/lib/research-result";
import type { RowWriteMetadata } from "@/lib/write-audit";
import { enforceNotionValueLimit, isValidHttpUrl } from "@/lib/notion-validation";

export const DEFAULT_NOTION_API_VERSION = "2025-09-03";

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

export function buildOperationalSchema(schema: NotionSchema): NotionSchema {
  return {
    ...schema,
    [NOTION_ROW_METADATA_PROPERTIES.operationKey]: "rich_text",
    [NOTION_ROW_METADATA_PROPERTIES.sourceSet]: "rich_text",
    [NOTION_ROW_METADATA_PROPERTIES.confidenceScore]: "number",
    [NOTION_ROW_METADATA_PROPERTIES.evidenceSummary]: "rich_text",
  };
}

export function buildDuplicateFingerprint(data: ResearchItem, schema: NotionSchema): string | null {
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

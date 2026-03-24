import {
  RESEARCH_ITEM_PROVENANCE_KEY,
  type ResearchItem,
  type ResearchItemProvenance,
} from "./research-result";

export const NOTION_PROPERTY_TYPES = ["title", "rich_text", "url", "number", "select"] as const;
export type NotionPropertyType = (typeof NOTION_PROPERTY_TYPES)[number];
export type NotionSchemaLike = Record<string, NotionPropertyType>;

export type SharedValidationIssue = {
  rowIndex: number;
  columnName: string;
  message: string;
};

export const NOTION_FIELD_LIMITS = {
  title: 2000,
  rich_text: 2000,
  url: 2000,
} as const;

export function isValidDatabaseId(value: string): boolean {
  return (
    /^[a-f0-9]{32}$/i.test(value) ||
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeTextValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

export function normalizeNumberValue(value: string): string | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? String(numberValue) : null;
}

function clampStringValue(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function clampUrlValue(value: string): string {
  let candidate = clampStringValue(value, NOTION_FIELD_LIMITS.url);

  while (candidate && !isValidHttpUrl(candidate)) {
    candidate = candidate.slice(0, -1);
  }

  return candidate;
}

export function enforceNotionValueLimit(value: string, type: NotionPropertyType): string {
  const normalizedValue = normalizeTextValue(value);

  if (type === "url") {
    return clampUrlValue(normalizedValue);
  }

  if (type === "title" || type === "rich_text") {
    return clampStringValue(normalizedValue, NOTION_FIELD_LIMITS[type]);
  }

  return normalizedValue;
}

function getItemTextValue(item: ResearchItem, key: string): string {
  return typeof item[key] === "string" ? item[key] : "";
}

function getItemProvenance(item: ResearchItem): ResearchItemProvenance | undefined {
  const provenance = item[RESEARCH_ITEM_PROVENANCE_KEY];
  return provenance && typeof provenance === "object" ? (provenance as ResearchItemProvenance) : undefined;
}

export function getResearchItemValidationIssues(
  item: ResearchItem,
  schema: NotionSchemaLike,
  rowIndex: number
): SharedValidationIssue[] {
  const issues: SharedValidationIssue[] = [];
  const titleColumn = Object.entries(schema).find(([, type]) => type === "title")?.[0];
  const populatedColumns = Object.entries(schema)
    .filter(
      ([columnName, propertyType]) =>
        propertyType !== "url" && getItemTextValue(item, columnName).trim().length > 0
    )
    .map(([columnName]) => columnName);

  if (titleColumn && !getItemTextValue(item, titleColumn).trim()) {
    issues.push({
      rowIndex,
      columnName: titleColumn,
      message: `Row ${rowIndex + 1} is missing a title value.`,
    });
  }

  for (const [columnName, propertyType] of Object.entries(schema)) {
    const value = getItemTextValue(item, columnName).trim();

    if (!value) continue;

    if (propertyType === "url" && !isValidHttpUrl(value)) {
      issues.push({
        rowIndex,
        columnName,
        message: `Row ${rowIndex + 1} has an invalid URL in "${columnName}".`,
      });
    }

    if (propertyType === "number" && normalizeNumberValue(value) === null) {
      issues.push({
        rowIndex,
        columnName,
        message: `Row ${rowIndex + 1} has a non-numeric value in "${columnName}".`,
      });
    }
  }

  if (populatedColumns.length === 0) {
    return issues;
  }

  const provenance = getItemProvenance(item);
  const evidenceByField = provenance?.evidenceByField ?? {};
  const evidenceCoveredFields = populatedColumns.filter(
    (columnName) => (evidenceByField[columnName] ?? []).filter(Boolean).length > 0
  );
  const missingEvidenceFields = populatedColumns.filter(
    (columnName) => !evidenceCoveredFields.includes(columnName)
  );
  const issueColumn = titleColumn ?? populatedColumns[0];

  if (!provenance?.sourceUrls?.length) {
    issues.push({
      rowIndex,
      columnName: issueColumn,
      message: `Row ${rowIndex + 1} must include at least one provenance source URL.`,
    });
  }

  if (!Object.keys(evidenceByField).length) {
    issues.push({
      rowIndex,
      columnName: issueColumn,
      message: `Row ${rowIndex + 1} must include field-level evidence snippets.`,
    });
    return issues;
  }

  if (missingEvidenceFields.length > 0) {
    issues.push({
      rowIndex,
      columnName: missingEvidenceFields[0] ?? issueColumn,
      message: `Row ${rowIndex + 1} must include evidence for every populated field. Missing: ${missingEvidenceFields.join(", ")}.`,
    });
  }

  return issues;
}

import {
  RESEARCH_ITEM_PROVENANCE_KEY,
  type ResearchItem,
  type ResearchItemProvenance,
} from "@/lib/research-result";
import type { EditableResult, PropertyType, ValidationIssue } from "./types";

const MIN_EVIDENCE_DENSITY = 0.5;

export function formatPropertyTypeLabel(type: PropertyType): string {
  return type
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getSafeFilename(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[^a-z0-9_ -]/gi, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();

  return sanitized || fallback;
}

export function getUniqueColumnName(
  requestedName: string,
  schema: Record<string, PropertyType>,
  excludeName?: string
): string {
  const trimmed = requestedName.trim() || "New Field";
  const lowerExcluded = excludeName?.toLowerCase();

  if (
    !Object.keys(schema).some(
      (key) => key.toLowerCase() === trimmed.toLowerCase() && key.toLowerCase() !== lowerExcluded
    )
  ) {
    return trimmed;
  }

  let suffix = 2;
  let candidate = `${trimmed} ${suffix}`;

  while (
    Object.keys(schema).some(
      (key) => key.toLowerCase() === candidate.toLowerCase() && key.toLowerCase() !== lowerExcluded
    )
  ) {
    suffix += 1;
    candidate = `${trimmed} ${suffix}`;
  }

  return candidate;
}

export function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, item);
  return nextItems;
}

function escapeCsvValue(value: string): string {
  if (value.includes('"') || /[,\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

export function buildCsv(result: EditableResult): string {
  const columns = Object.keys(result.schema);
  const header = columns.map(escapeCsvValue).join(",");
  const rows = result.items.map((item) =>
    columns.map((column) => escapeCsvValue(getItemTextValue(item, column))).join(",")
  );

  return [header, ...rows].join("\n");
}

export function buildNotionWebUrl(databaseId: string): string {
  return `https://www.notion.so/${databaseId.replace(/-/g, "")}`;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getItemTextValue(item: ResearchItem, key: string): string {
  return typeof item[key] === "string" ? item[key] : "";
}

export function getItemProvenance(item: ResearchItem): ResearchItemProvenance | undefined {
  const provenance = item[RESEARCH_ITEM_PROVENANCE_KEY];
  return provenance && typeof provenance === "object" ? (provenance as ResearchItemProvenance) : undefined;
}

export function getValidationIssues(result: EditableResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const titleColumn = Object.entries(result.schema).find(([, type]) => type === "title")?.[0];

  result.items.forEach((item, rowIndex) => {
    const populatedColumns = Object.entries(result.schema)
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

    for (const [columnName, propertyType] of Object.entries(result.schema)) {
      const value = getItemTextValue(item, columnName).trim();

      if (!value) continue;

      if (propertyType === "url" && !isValidHttpUrl(value)) {
        issues.push({
          rowIndex,
          columnName,
          message: `Row ${rowIndex + 1} has an invalid URL in "${columnName}".`,
        });
      }

      if (propertyType === "number" && !Number.isFinite(Number(value))) {
        issues.push({
          rowIndex,
          columnName,
          message: `Row ${rowIndex + 1} has a non-numeric value in "${columnName}".`,
        });
      }
    }

    if (populatedColumns.length === 0) {
      return;
    }

    const provenance = getItemProvenance(item);
    const evidenceByField = provenance?.evidenceByField ?? {};
    const evidenceCoveredFields = populatedColumns.filter(
      (columnName) => (evidenceByField[columnName] ?? []).filter(Boolean).length > 0
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
      return;
    }

    if (titleColumn && populatedColumns.includes(titleColumn) && !(evidenceByField[titleColumn] ?? []).length) {
      issues.push({
        rowIndex,
        columnName: titleColumn,
        message: `Row ${rowIndex + 1} must include evidence for "${titleColumn}".`,
      });
    }

    const minimumEvidenceFields = Math.max(
      1,
      Math.ceil(populatedColumns.length * MIN_EVIDENCE_DENSITY)
    );

    if (evidenceCoveredFields.length < minimumEvidenceFields) {
      issues.push({
        rowIndex,
        columnName: issueColumn,
        message: `Row ${rowIndex + 1} needs denser evidence coverage before approval.`,
      });
    }
  });

  return issues;
}

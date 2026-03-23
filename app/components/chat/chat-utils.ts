import { getResearchItemValidationIssues } from "@/lib/notion-validation";
import {
  RESEARCH_ITEM_PROVENANCE_KEY,
  type ResearchItem,
  type ResearchItemProvenance,
} from "@/lib/research-result";
import type { EditableResult, PropertyType, ValidationIssue } from "./types";

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

export function getItemTextValue(item: ResearchItem, key: string): string {
  return typeof item[key] === "string" ? item[key] : "";
}

export function getItemProvenance(item: ResearchItem): ResearchItemProvenance | undefined {
  const provenance = item[RESEARCH_ITEM_PROVENANCE_KEY];
  return provenance && typeof provenance === "object" ? (provenance as ResearchItemProvenance) : undefined;
}

export function getValidationIssues(result: EditableResult): ValidationIssue[] {
  return result.items.flatMap((item, rowIndex) =>
    getResearchItemValidationIssues(item, result.schema, rowIndex)
  );
}

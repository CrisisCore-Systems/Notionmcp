import { isValidDatabaseId } from "@/lib/notion-validation";

export const DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY = "Research Prompt";
export const DEFAULT_NOTION_QUEUE_TITLE_PROPERTY = "Name";
export const DEFAULT_NOTION_QUEUE_STATUS_PROPERTY = "Status";
export const DEFAULT_NOTION_QUEUE_READY_VALUE = "Ready";
export const DEFAULT_NOTION_QUEUE_IN_PROGRESS_VALUE = "In Progress";
export const DEFAULT_NOTION_QUEUE_NEEDS_REVIEW_VALUE = "Needs Review";
export const DEFAULT_NOTION_QUEUE_PACKET_READY_VALUE = "Packet Ready";
export const DEFAULT_NOTION_QUEUE_ERROR_VALUE = "Error";
export const DEFAULT_NOTION_QUEUE_CLAIMED_AT_PROPERTY = "Claimed At";
export const DEFAULT_NOTION_QUEUE_CLAIMED_BY_PROPERTY = "Claimed By";
export const DEFAULT_NOTION_QUEUE_RUN_ID_PROPERTY = "Run ID";
export const DEFAULT_NOTION_QUEUE_LAST_RESEARCHED_AT_PROPERTY = "Last Researched At";
export const DEFAULT_NOTION_QUEUE_RESEARCH_SUMMARY_PROPERTY = "Research Summary";
export const DEFAULT_NOTION_QUEUE_RECOMMENDED_DIRECTION_PROPERTY = "Recommended Direction";
export const DEFAULT_NOTION_QUEUE_COMPETITORS_PROPERTY = "Competitors";
export const DEFAULT_NOTION_QUEUE_SOURCE_COUNT_PROPERTY = "Source Count";
export const DEFAULT_NOTION_QUEUE_LAST_RUN_STATUS_PROPERTY = "Last Run Status";
export const DEFAULT_NOTION_QUEUE_AUDIT_LOCATOR_PROPERTY = "Audit URL or Job ID";
export const DEFAULT_NOTION_QUEUE_EVIDENCE_BLOCK_PROPERTY = "Evidence Block";
export const DEFAULT_NOTION_QUEUE_CONFIDENCE_NOTE_PROPERTY = "Confidence Note";

export type NotionQueueConfig = {
  databaseId: string;
  promptProperty: string;
  titleProperty: string;
  statusProperty: string;
  readyValue: string;
};

type NotionQueueEntry = {
  databaseId?: unknown;
  promptProperty?: unknown;
  titleProperty?: unknown;
  statusProperty?: unknown;
  readyValue?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function normalizeNotionQueueConfig(value: unknown): NotionQueueConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const entry = value as NotionQueueEntry;
  const databaseId = typeof entry.databaseId === "string" ? entry.databaseId.trim() : "";

  if (!databaseId) {
    return null;
  }

  return {
    databaseId,
    promptProperty: normalizeText(entry.promptProperty, DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY),
    titleProperty: normalizeText(entry.titleProperty, DEFAULT_NOTION_QUEUE_TITLE_PROPERTY),
    statusProperty: normalizeText(entry.statusProperty, DEFAULT_NOTION_QUEUE_STATUS_PROPERTY),
    readyValue: normalizeText(entry.readyValue, DEFAULT_NOTION_QUEUE_READY_VALUE),
  };
}

export function getNotionQueueConfigValidationError(config: NotionQueueConfig): string | null {
  if (!isValidDatabaseId(config.databaseId)) {
    return "A valid Notion database ID is required for notionQueue intake";
  }

  return null;
}

export function buildResearchPromptFromNotionQueueItem(item: {
  title?: string;
  prompt?: string;
}): string {
  const prompt = item.prompt?.trim();

  if (prompt) {
    return prompt;
  }

  const title = item.title?.trim();
  return title ? `Research this Notion backlog item: ${title}` : "";
}

import type { NotionSchema } from "@/lib/notion-mcp";

export interface ResearchResult {
  suggestedDbTitle: string;
  summary: string;
  schema: NotionSchema;
  items: Record<string, string>[];
}

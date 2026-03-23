import type { NotionSchema } from "@/lib/notion-mcp";

export const RESEARCH_ITEM_PROVENANCE_KEY = "__provenance";

export interface ResearchItemProvenance {
  sourceUrls: string[];
  evidenceByField?: Record<string, string[]>;
}

export interface ResearchItem extends Record<string, unknown> {
  [RESEARCH_ITEM_PROVENANCE_KEY]?: ResearchItemProvenance;
}

export interface ResearchResult {
  suggestedDbTitle: string;
  summary: string;
  schema: NotionSchema;
  items: ResearchItem[];
}

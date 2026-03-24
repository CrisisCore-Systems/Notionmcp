import type { NotionSchema } from "@/lib/notion/provider";

export const RESEARCH_ITEM_PROVENANCE_KEY = "__provenance";
export const RESEARCH_RUN_METADATA_KEY = "__runMetadata";

export interface ResearchItemProvenance {
  sourceUrls: string[];
  evidenceByField?: Record<string, string[]>;
}

export interface ResearchExtractionCounts {
  searchQueries: number;
  candidateSources: number;
  pagesBrowsed: number;
  rowsExtracted: number;
}

export interface ResearchSearchMetadata {
  configuredProviders: string[];
  usedProviders: string[];
  degraded: boolean;
  mode?: "fast" | "deep";
  profile?: {
    maxPlannedQueries: number;
    maxEvidenceDocuments: number;
    minUniqueDomains: number;
    minSourceClasses: number;
  };
  uniqueDomains?: string[];
  sourceClasses?: string[];
}

export interface ResearchRunMetadata {
  sourceSet: string[];
  extractionCounts: ResearchExtractionCounts;
  rejectedUrls: string[];
  search?: ResearchSearchMetadata;
}

export interface ResearchItem extends Record<string, unknown> {
  [RESEARCH_ITEM_PROVENANCE_KEY]?: ResearchItemProvenance;
}

export interface ResearchResult {
  suggestedDbTitle: string;
  summary: string;
  schema: NotionSchema;
  items: ResearchItem[];
  [RESEARCH_RUN_METADATA_KEY]?: ResearchRunMetadata;
}

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
    plannerModel?: string;
    verifierModel?: string;
    maxReconciliationAttempts?: number;
    maxPlannedQueries: number;
    maxEvidenceDocuments: number;
    minUniqueDomains: number;
    minSourceClasses: number;
    minIndependentSourcesPerField?: number;
    minCrossSourceAgreement?: number;
  };
  uniqueDomains?: string[];
  sourceClasses?: string[];
  sourceQuality?: {
    averageScore: number;
    primarySourceCount: number;
    officialSourceCount: number;
    dateAvailableSourceCount: number;
    authorAvailableSourceCount: number;
    strongestSourceUrls: string[];
  };
  freshness?: {
    timeSensitivePrompt: boolean;
    sourceCountWithDates: number;
  };
}

export interface ResearchNotionQueueMetadata {
  databaseId: string;
  pageId: string;
  title: string;
  statusProperty: string;
  runId: string;
  claimedBy: string;
  connectionId?: string;
  claimedAt?: string;
  propertyTypes?: Record<string, string>;
}

export interface ResearchRunMetadata {
  sourceSet: string[];
  extractionCounts: ResearchExtractionCounts;
  rejectedUrls: string[];
  search?: ResearchSearchMetadata;
  notionConnectionId?: string;
  notionQueue?: ResearchNotionQueueMetadata;
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

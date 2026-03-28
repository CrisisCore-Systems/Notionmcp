import type { ResearchItem } from "@/lib/research-result";
import type { RowWriteMetadata } from "@/lib/write-audit";

export interface DuplicateTracker {
  has(data: ResearchItem, operationKey?: string): boolean;
  remember(data: ResearchItem, operationKey?: string): void;
}

export interface NotionSchema {
  [propertyName: string]: "title" | "rich_text" | "url" | "number" | "select";
}

export type NotionWriteMetadataSupport = {
  operationKey: boolean;
  sourceSet: boolean;
  confidenceScore: boolean;
  evidenceSummary: boolean;
};

export type CreateDatabaseInput = {
  title: string;
  schema: NotionSchema;
  parentPageId?: string;
};

export type QueryExistingRowsInput = {
  databaseId: string;
  schema: NotionSchema;
  options?: {
    prefetchExisting?: boolean;
    useOperationKeyLookup?: boolean;
    operationKeys?: string[];
  };
};

export type ExistingRowIndex = DuplicateTracker;

export type CreatePageInput = {
  databaseId: string;
  data: ResearchItem;
  schema: NotionSchema;
  duplicateTracker?: DuplicateTracker;
  writeMetadata?: RowWriteMetadata;
  metadataSupport?: NotionWriteMetadataSupport;
};

export interface NotionProvider {
  createDatabase(input: CreateDatabaseInput): Promise<{ databaseId: string }>;
  getDatabaseMetadataSupport(databaseId: string): Promise<NotionWriteMetadataSupport>;
  queryExistingRows(input: QueryExistingRowsInput): Promise<ExistingRowIndex>;
  createPage(input: CreatePageInput): Promise<{ created: boolean }>;
}

import {
  addRow,
  createDatabase,
  createDuplicateTracker,
  getDatabaseMetadataSupport,
} from "@/lib/notion-mcp";
import type { NotionProvider } from "@/lib/notion/provider";

export function createLocalMcpNotionProvider(): NotionProvider {
  return {
    async createDatabase(input) {
      return {
        databaseId: await createDatabase(input.title, input.schema),
      };
    },
    async getDatabaseMetadataSupport(databaseId) {
      return await getDatabaseMetadataSupport(databaseId);
    },
    async queryExistingRows(input) {
      return await createDuplicateTracker(input.databaseId, input.schema, input.options);
    },
    async createPage(input) {
      return await addRow(
        input.databaseId,
        input.data,
        input.schema,
        input.duplicateTracker,
        input.writeMetadata,
        input.metadataSupport
      );
    },
  };
}

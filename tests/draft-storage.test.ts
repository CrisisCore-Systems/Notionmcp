import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_STORAGE_KEY,
  DRAFT_TTL_MS,
  loadStoredDraft,
  saveStoredDraft,
} from "@/app/components/chat/draft-storage";
import type { StoredDraft } from "@/app/components/chat/types";

type MemoryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  store: Map<string, string>;
};

function createStorage(options?: { failOnSet?: boolean }): MemoryStorage {
  const store = new Map<string, string>();

  return {
    store,
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      if (options?.failOnSet) {
        throw new Error("Quota exceeded");
      }

      store.set(key, value);
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

function createDraft(): StoredDraft {
  return {
    prompt: "Research prompt",
    editedResult: {
      suggestedDbTitle: "Research",
      summary: "Summary",
      schema: { Name: "title" },
      items: [
        {
          Name: "Alpha",
          __provenance: {
            sourceUrls: ["https://example.com"],
            evidenceByField: {
              Name: ["Alpha is named on the page"],
            },
          },
        },
      ],
    },
    useExistingDatabase: false,
    targetDatabaseId: "",
    pendingWriteResume: null,
  };
}

test("loadStoredDraft drops expired drafts", () => {
  const storage = createStorage();
  const savedAt = Date.now() - DRAFT_TTL_MS - 1;
  storage.store.set(
    DRAFT_STORAGE_KEY,
    JSON.stringify({
      ...createDraft(),
      version: 1,
      savedAt,
    })
  );

  const loaded = loadStoredDraft(storage, Date.now());

  assert.equal(loaded, null);
  assert.equal(storage.store.has(DRAFT_STORAGE_KEY), false);
});

test("saveStoredDraft handles browser storage write failures", () => {
  const storage = createStorage({ failOnSet: true });
  const result = saveStoredDraft(storage, createDraft(), Date.now());

  assert.equal(result.savedDraft, null);
  assert.match(result.notice ?? "", /browser storage is unavailable or full/);
  assert.equal(storage.store.has(DRAFT_STORAGE_KEY), false);
});

import type { StoredDraft } from "./types";

export const DRAFT_STORAGE_KEY = "notion-mcp-backlog-desk-draft";
export const LEGACY_DRAFT_STORAGE_KEY = "notion-research-agent-draft";
export const DRAFT_PERSISTENCE_PREFERENCE_KEY = "notion-mcp-backlog-desk-draft-persistence-enabled";
export const LEGACY_DRAFT_PERSISTENCE_PREFERENCE_KEY = "notion-research-agent-draft-persistence-enabled";
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DRAFT_MAX_SIZE_BYTES = 2 * 1024 * 1024;
export const DRAFT_WARNING_SIZE_BYTES = 250 * 1024;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type StoredDraftRecord = StoredDraft & {
  version: 1;
  savedAt: number;
};

export type DraftPersistenceResult = {
  savedDraft: StoredDraft | null;
  notice: string | null;
};

function getDraftStorageKeys(): string[] {
  return [DRAFT_STORAGE_KEY, LEGACY_DRAFT_STORAGE_KEY];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStoredDraftRecord(value: unknown): value is StoredDraftRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.savedAt === "number" &&
    typeof value.prompt === "string" &&
    typeof value.targetDatabaseId === "string" &&
    typeof value.notionParentPageId === "string" &&
    typeof value.useExistingDatabase === "boolean" &&
    value.pendingWriteResume !== undefined &&
    isRecord(value.editedResult)
  );
}

function getByteSize(value: string): number {
  return new TextEncoder().encode(value).length;
}

function stripDraftMetadata(value: StoredDraftRecord): StoredDraft {
  return {
    prompt: value.prompt,
    editedResult: value.editedResult,
    useExistingDatabase: value.useExistingDatabase,
    targetDatabaseId: value.targetDatabaseId,
    notionParentPageId: value.notionParentPageId,
    pendingWriteResume: value.pendingWriteResume,
  };
}

export function loadStoredDraft(
  storage: StorageLike,
  currentTimeMs = Date.now()
): StoredDraft | null {
  try {
    const rawDraft = getDraftStorageKeys()
      .map((key) => ({ key, value: storage.getItem(key) }))
      .find((entry) => !!entry.value);
    if (!rawDraft?.value) return null;

    const parsed = JSON.parse(rawDraft.value) as unknown;

    if (!isStoredDraftRecord(parsed)) {
      storage.removeItem(rawDraft.key);
      return null;
    }

    if (currentTimeMs - parsed.savedAt > DRAFT_TTL_MS) {
      storage.removeItem(rawDraft.key);
      return null;
    }

    if (rawDraft.key !== DRAFT_STORAGE_KEY) {
      storage.removeItem(rawDraft.key);
      storage.setItem(DRAFT_STORAGE_KEY, rawDraft.value);
    }

    return stripDraftMetadata(parsed);
  } catch {
    for (const key of getDraftStorageKeys()) {
      storage.removeItem(key);
    }
    return null;
  }
}

export function saveStoredDraft(
  storage: StorageLike,
  draft: StoredDraft,
  currentTimeMs = Date.now()
): DraftPersistenceResult {
  const serialized = JSON.stringify({
    ...draft,
    version: 1,
    savedAt: currentTimeMs,
  } satisfies StoredDraftRecord);
  const draftSize = getByteSize(serialized);

  if (draftSize > DRAFT_MAX_SIZE_BYTES) {
    storage.removeItem(DRAFT_STORAGE_KEY);
    return {
      savedDraft: null,
      notice: "Draft is too large to save locally. Export it instead or keep working without draft persistence.",
    };
  }

  try {
    storage.setItem(DRAFT_STORAGE_KEY, serialized);
    storage.removeItem(LEGACY_DRAFT_STORAGE_KEY);
  } catch {
    storage.removeItem(DRAFT_STORAGE_KEY);
    return {
      savedDraft: null,
      notice: "Could not save the draft locally because browser storage is unavailable or full.",
    };
  }

  return {
    savedDraft: draft,
    notice:
      draftSize >= DRAFT_WARNING_SIZE_BYTES
        ? "Large draft saved locally. Shared or storage-constrained browsers may clear it sooner than expected."
        : null,
  };
}

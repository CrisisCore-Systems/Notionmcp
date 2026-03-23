import type { StoredDraft } from "./types";

export const DRAFT_STORAGE_KEY = "notion-research-agent-draft";
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
    pendingWriteResume: value.pendingWriteResume,
  };
}

export function loadStoredDraft(
  storage: Pick<Storage, "getItem" | "removeItem">,
  currentTimeMs = Date.now()
): StoredDraft | null {
  try {
    const rawDraft = storage.getItem(DRAFT_STORAGE_KEY);
    if (!rawDraft) return null;

    const parsed = JSON.parse(rawDraft) as unknown;

    if (!isStoredDraftRecord(parsed)) {
      storage.removeItem(DRAFT_STORAGE_KEY);
      return null;
    }

    if (currentTimeMs - parsed.savedAt > DRAFT_TTL_MS) {
      storage.removeItem(DRAFT_STORAGE_KEY);
      return null;
    }

    return stripDraftMetadata(parsed);
  } catch {
    storage.removeItem(DRAFT_STORAGE_KEY);
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

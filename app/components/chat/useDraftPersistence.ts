import { useCallback, useEffect, useState } from "react";
import { DRAFT_STORAGE_KEY, loadStoredDraft, saveStoredDraft } from "./draft-storage";
import type { EditableResult, PendingWriteResume, Phase, StoredDraft } from "./types";

type UseDraftPersistenceOptions = {
  phase: Phase;
  prompt: string;
  editedResult: EditableResult | null;
  useExistingDatabase: boolean;
  targetDatabaseId: string;
  pendingWriteResume: PendingWriteResume | null;
  persistenceEnabled: boolean;
};

export function useDraftPersistence({
  phase,
  prompt,
  editedResult,
  useExistingDatabase,
  targetDatabaseId,
  pendingWriteResume,
  persistenceEnabled,
}: UseDraftPersistenceOptions) {
  const [savedDraft, setSavedDraft] = useState<StoredDraft | null>(null);
  const [draftPersistenceNotice, setDraftPersistenceNotice] = useState<string | null>(null);

  const clearSavedDraft = useCallback(() => {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    setSavedDraft(null);
  }, []);

  useEffect(() => {
    setSavedDraft(loadStoredDraft(window.localStorage));
  }, []);

  useEffect(() => {
    if (!persistenceEnabled) {
      clearSavedDraft();
      setDraftPersistenceNotice("Draft persistence is off for this browser session.");
      return;
    }

    if (!editedResult || !["approving", "error"].includes(phase)) return;

    const draft: StoredDraft = {
      prompt,
      editedResult,
      useExistingDatabase,
      targetDatabaseId,
      pendingWriteResume,
    };

    const result = saveStoredDraft(window.localStorage, draft);
    setSavedDraft(result.savedDraft);
    setDraftPersistenceNotice(result.notice);
  }, [
    clearSavedDraft,
    editedResult,
    pendingWriteResume,
    persistenceEnabled,
    phase,
    prompt,
    targetDatabaseId,
    useExistingDatabase,
  ]);

  return {
    savedDraft,
    setSavedDraft,
    clearSavedDraft,
    draftPersistenceNotice,
  };
}

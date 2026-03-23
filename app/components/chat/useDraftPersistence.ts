import { useCallback, useEffect, useState } from "react";
import type { EditableResult, PendingWriteResume, Phase, StoredDraft } from "./types";

const DRAFT_STORAGE_KEY = "notion-research-agent-draft";

type UseDraftPersistenceOptions = {
  phase: Phase;
  prompt: string;
  editedResult: EditableResult | null;
  useExistingDatabase: boolean;
  targetDatabaseId: string;
  pendingWriteResume: PendingWriteResume | null;
};

export function useDraftPersistence({
  phase,
  prompt,
  editedResult,
  useExistingDatabase,
  targetDatabaseId,
  pendingWriteResume,
}: UseDraftPersistenceOptions) {
  const [savedDraft, setSavedDraft] = useState<StoredDraft | null>(null);

  useEffect(() => {
    try {
      const rawDraft = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!rawDraft) return;

      setSavedDraft(JSON.parse(rawDraft) as StoredDraft);
    } catch {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!editedResult || !["approving", "error"].includes(phase)) return;

    const draft: StoredDraft = {
      prompt,
      editedResult,
      useExistingDatabase,
      targetDatabaseId,
      pendingWriteResume,
    };

    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    setSavedDraft(draft);
  }, [editedResult, pendingWriteResume, phase, prompt, targetDatabaseId, useExistingDatabase]);

  const clearSavedDraft = useCallback(() => {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    setSavedDraft(null);
  }, []);

  return {
    savedDraft,
    setSavedDraft,
    clearSavedDraft,
  };
}

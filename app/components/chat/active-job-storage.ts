export const ACTIVE_JOB_STORAGE_KEY = "notionmcp.activeJob";

export type ActiveJobState = {
  kind: "research" | "write";
  jobId: string;
};

export function loadActiveJob(storage: Storage): ActiveJobState | null {
  const raw = storage.getItem(ACTIVE_JOB_STORAGE_KEY);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ActiveJobState>;

    if (
      (parsed.kind === "research" || parsed.kind === "write") &&
      typeof parsed.jobId === "string" &&
      parsed.jobId.trim()
    ) {
      return {
        kind: parsed.kind,
        jobId: parsed.jobId.trim(),
      };
    }
  } catch {
    // Ignore malformed local state and let the operator start a fresh run.
  }

  return null;
}

export function saveActiveJob(storage: Storage, job: ActiveJobState) {
  storage.setItem(ACTIVE_JOB_STORAGE_KEY, JSON.stringify(job));
}

export function clearActiveJob(storage: Storage) {
  storage.removeItem(ACTIVE_JOB_STORAGE_KEY);
}

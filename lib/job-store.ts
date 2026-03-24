import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type JobKind = "research" | "write";
export type JobStatus = "queued" | "running" | "complete" | "error";
export type JobEventType = "job" | "update" | "continue" | "complete" | "error";

export type JobCheckpoint = {
  phase?: string;
  databaseId?: string;
  nextRowIndex?: number;
  resumedFromIndex?: number;
  providerMode?: string;
  searchQueries?: string[];
  evidenceDocumentCount?: number;
  pagesBrowsed?: number;
};

export type PersistedJobEvent = {
  id: number;
  event: JobEventType;
  data: unknown;
  createdAt: string;
};

export type PersistedJobRecord = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  payload: unknown;
  events: PersistedJobEvent[];
  checkpoint?: JobCheckpoint;
  result?: unknown;
  error?: unknown;
  worker?: {
    pid: number;
    heartbeatAt: string;
  };
};

const JOB_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;
const DEFAULT_WORKER_STALE_MS = 15000;

export function getJobDirectory(): string {
  const configured = process.env.JOB_STATE_DIR?.trim();
  return configured || path.join(process.cwd(), ".notionmcp-data", "jobs");
}

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId.trim());
}

function getJobPath(jobId: string): string {
  if (!isValidJobId(jobId)) {
    throw new Error("Invalid job ID");
  }

  return path.join(getJobDirectory(), `${jobId.trim()}.json`);
}

async function saveJobRecord(record: PersistedJobRecord): Promise<PersistedJobRecord> {
  await mkdir(getJobDirectory(), { recursive: true });
  await writeFile(getJobPath(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function createJob(kind: JobKind, payload: unknown): Promise<PersistedJobRecord> {
  const timestamp = new Date().toISOString();
  return await saveJobRecord({
    id: randomUUID(),
    kind,
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    payload,
    events: [],
  });
}

export async function loadJobRecord(jobId: string): Promise<PersistedJobRecord | null> {
  const trimmedJobId = jobId.trim();

  if (!isValidJobId(trimmedJobId)) {
    return null;
  }

  try {
    const raw = await readFile(getJobPath(trimmedJobId), "utf8");
    return JSON.parse(raw) as PersistedJobRecord;
  } catch {
    return null;
  }
}

export async function updateJobRecord(
  jobId: string,
  updater: (record: PersistedJobRecord) => PersistedJobRecord
): Promise<PersistedJobRecord> {
  const record = await loadJobRecord(jobId);

  if (!record) {
    throw new Error(`Job "${jobId}" was not found.`);
  }

  return await saveJobRecord(
    updater({
      ...record,
      events: Array.isArray(record.events) ? [...record.events] : [],
    })
  );
}

export async function appendJobEvent(
  jobId: string,
  event: JobEventType,
  data: unknown,
  checkpoint?: Partial<JobCheckpoint>
): Promise<PersistedJobRecord> {
  return await updateJobRecord(jobId, (record) => {
    const timestamp = new Date().toISOString();
    const nextCheckpoint = checkpoint ? { ...(record.checkpoint ?? {}), ...checkpoint } : record.checkpoint;

    return {
      ...record,
      updatedAt: timestamp,
      checkpoint: nextCheckpoint,
      events: [
        ...record.events,
        {
          id: (record.events.at(-1)?.id ?? 0) + 1,
          event,
          data,
          createdAt: timestamp,
        },
      ],
    };
  });
}

export async function markJobRunning(
  jobId: string,
  worker: { pid: number },
  checkpoint?: Partial<JobCheckpoint>
): Promise<PersistedJobRecord> {
  return await updateJobRecord(jobId, (record) => ({
    ...record,
    status: "running",
    updatedAt: new Date().toISOString(),
    checkpoint: checkpoint ? { ...(record.checkpoint ?? {}), ...checkpoint } : record.checkpoint,
    worker: {
      pid: worker.pid,
      heartbeatAt: new Date().toISOString(),
    },
  }));
}

export async function touchJobHeartbeat(
  jobId: string,
  checkpoint?: Partial<JobCheckpoint>
): Promise<PersistedJobRecord> {
  return await updateJobRecord(jobId, (record) => ({
    ...record,
    updatedAt: new Date().toISOString(),
    checkpoint: checkpoint ? { ...(record.checkpoint ?? {}), ...checkpoint } : record.checkpoint,
    worker: record.worker
      ? {
          ...record.worker,
          heartbeatAt: new Date().toISOString(),
        }
      : undefined,
  }));
}

export async function markJobComplete(
  jobId: string,
  result: unknown,
  checkpoint?: Partial<JobCheckpoint>
): Promise<PersistedJobRecord> {
  const record = await appendJobEvent(jobId, "complete", result, checkpoint);
  return await updateJobRecord(record.id, (nextRecord) => ({
    ...nextRecord,
    status: "complete",
    result,
    updatedAt: new Date().toISOString(),
  }));
}

export async function markJobError(
  jobId: string,
  error: unknown,
  checkpoint?: Partial<JobCheckpoint>
): Promise<PersistedJobRecord> {
  const record = await appendJobEvent(jobId, "error", error, checkpoint);
  return await updateJobRecord(record.id, (nextRecord) => ({
    ...nextRecord,
    status: "error",
    error,
    updatedAt: new Date().toISOString(),
  }));
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "complete" || status === "error";
}

export function isTerminalJob(record: PersistedJobRecord): boolean {
  return isTerminalJobStatus(record.status);
}

export function isJobWorkerStale(
  record: PersistedJobRecord,
  now = Date.now(),
  staleAfterMs = DEFAULT_WORKER_STALE_MS
): boolean {
  if (record.status === "queued") {
    return true;
  }

  if (record.status !== "running") {
    return false;
  }

  const heartbeatAt = record.worker?.heartbeatAt ? Date.parse(record.worker.heartbeatAt) : NaN;
  return !Number.isFinite(heartbeatAt) || now - heartbeatAt > staleAfterMs;
}

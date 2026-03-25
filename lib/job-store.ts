import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  createEventIntegrity,
  signArtifactIntegrity,
  type ArtifactIntegrityMetadata,
  verifyArtifactIntegrity,
  verifyChainedEvents,
} from "@/lib/artifact-integrity";
import { readPersistedStateFile, writePersistedStateFile } from "@/lib/persisted-state";

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
  eventHash: string;
  previousEventHash?: string;
};

export type PersistedJobIntegrity = ArtifactIntegrityMetadata & {
  finalEventChainHash?: string;
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
  integrity?: PersistedJobIntegrity;
};

const JOB_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;
const DEFAULT_WORKER_STALE_MS = 15000;
const JOB_STATE_RETENTION_ENV_VAR = "JOB_STATE_RETENTION_DAYS";

export function getJobDirectory(): string {
  const configured = process.env.JOB_STATE_DIR?.trim();
  return configured || path.join(process.cwd(), ".notionmcp-data", "jobs");
}

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId.trim());
}

export function buildJobStateUrl(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId.trim())}`;
}

function getJobPath(jobId: string): string {
  if (!isValidJobId(jobId)) {
    throw new Error("Invalid job ID");
  }

  return path.join(getJobDirectory(), `${jobId.trim()}.json`);
}

async function saveJobRecord(record: PersistedJobRecord): Promise<PersistedJobRecord> {
  const filePath = getJobPath(record.id);
  const previousHash = record.integrity?.recordHash;
  const unsignedRecord = { ...record };
  delete unsignedRecord.integrity;
  const signedRecord: PersistedJobRecord = {
    ...unsignedRecord,
    integrity: await signArtifactIntegrity(
      filePath,
      "persisted-job-record",
      unsignedRecord,
      {
        ...(isTerminalJobStatus(unsignedRecord.status) && unsignedRecord.events.length > 0
          ? { finalEventChainHash: unsignedRecord.events.at(-1)?.eventHash }
          : {}),
      },
      previousHash
    ),
  };

  await writePersistedStateFile(filePath, signedRecord, JOB_STATE_RETENTION_ENV_VAR);
  return signedRecord;
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
    const record = await readPersistedStateFile<PersistedJobRecord>(
      getJobPath(trimmedJobId),
      JOB_STATE_RETENTION_ENV_VAR
    );
    const { integrity, ...unsignedRecord } = record;
    const eventVerification = verifyChainedEvents(unsignedRecord.events);

    if (!eventVerification.ok) {
      throw new Error(`Persisted job "${trimmedJobId}" failed integrity verification: ${eventVerification.reason}.`);
    }

    const integrityVerification = await verifyArtifactIntegrity(
      getJobPath(trimmedJobId),
      "persisted-job-record",
      unsignedRecord,
      {
        ...(isTerminalJobStatus(unsignedRecord.status) && unsignedRecord.events.length > 0
          ? { finalEventChainHash: unsignedRecord.events.at(-1)?.eventHash }
          : {}),
      },
      integrity
    );

    if (!integrityVerification.ok) {
      throw new Error(
        `Persisted job "${trimmedJobId}" failed integrity verification: ${integrityVerification.reason}.`
      );
    }

    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function listJobIds(): Promise<string[]> {
  try {
    const entries = await readdir(getJobDirectory(), { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && path.extname(entry.name) === ".json")
      .map((entry) => path.basename(entry.name, ".json"))
      .filter((jobId) => isValidJobId(jobId))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function listJobRecords(): Promise<PersistedJobRecord[]> {
  const jobIds = await listJobIds();
  const records = await Promise.all(jobIds.map((jobId) => loadJobRecord(jobId)));
  return records.filter((record): record is PersistedJobRecord => record !== null);
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
        createEventIntegrity(
          {
            id: (record.events.at(-1)?.id ?? 0) + 1,
            event,
            data,
            createdAt: timestamp,
          },
          record.events.at(-1)?.eventHash
        ),
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

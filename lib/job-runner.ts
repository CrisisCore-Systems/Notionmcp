import { spawn } from "node:child_process";
import path from "node:path";
import {
  appendJobEvent,
  createJob,
  isJobWorkerStale,
  isTerminalJob,
  loadJobRecord,
  markJobComplete,
  markJobError,
  markJobRunning,
  touchJobHeartbeat,
  type JobCheckpoint,
  type JobKind,
  type PersistedJobRecord,
} from "@/lib/job-store";
import { runResearchAgent } from "@/lib/agent";
import { executeWriteJob, WriteExecutionError, type WriteExecutionInput } from "@/lib/write-execution";

export async function createDurableJob(kind: JobKind, payload: unknown): Promise<PersistedJobRecord> {
  return await createJob(kind, payload);
}

export async function processJob(jobId: string): Promise<void> {
  const record = await loadJobRecord(jobId);

  if (!record || isTerminalJob(record)) {
    return;
  }

  await markJobRunning(jobId, { pid: process.pid }, record.checkpoint);

  try {
    if (record.kind === "research") {
      const payload = record.payload as { prompt?: string };
      const result = await runResearchAgent(payload.prompt ?? "", async (message, checkpoint) => {
        const mergedCheckpoint: Partial<JobCheckpoint> = {
          phase: checkpoint?.phase,
          searchQueries: checkpoint?.searchQueries,
          evidenceDocumentCount: checkpoint?.evidenceDocumentCount,
          pagesBrowsed: checkpoint?.pagesBrowsed,
        };
        await appendJobEvent(jobId, "update", { message }, mergedCheckpoint);
        await touchJobHeartbeat(jobId, mergedCheckpoint);
      });

      await markJobComplete(jobId, result, {
        phase: "complete",
      });
      return;
    }

    const payload = record.payload as WriteExecutionInput;
    const resumedPayload: WriteExecutionInput = {
      ...payload,
      targetDatabaseId: record.checkpoint?.databaseId ?? payload.targetDatabaseId,
      resumeFromIndex: record.checkpoint?.nextRowIndex ?? payload.resumeFromIndex ?? 0,
    };
    const result = await executeWriteJob(resumedPayload, {
      onUpdate: async (message, checkpoint) => {
        const mergedCheckpoint: Partial<JobCheckpoint> = {
          phase: "writing",
          databaseId: checkpoint?.databaseId ?? record.checkpoint?.databaseId,
          nextRowIndex: checkpoint?.nextRowIndex,
          resumedFromIndex: payload.resumeFromIndex ?? 0,
          providerMode: record.checkpoint?.providerMode,
        };
        await appendJobEvent(jobId, "update", { message }, mergedCheckpoint);
        await touchJobHeartbeat(jobId, mergedCheckpoint);
      },
    });

    await markJobComplete(jobId, result, {
      phase: "complete",
      databaseId: result.databaseId,
      nextRowIndex: result.auditTrail.rows.length + (result.resumedFromIndex ?? 0),
      resumedFromIndex: result.resumedFromIndex,
      providerMode: result.providerMode,
    });
  } catch (error) {
    if (error instanceof WriteExecutionError) {
      await markJobError(jobId, error.details, {
        phase: "error",
        databaseId: error.details.databaseId,
        nextRowIndex: error.details.nextRowIndex,
        providerMode: error.details.providerMode,
      });
      return;
    }

    await markJobError(jobId, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function ensureJobWorker(jobId: string): Promise<void> {
  const record = await loadJobRecord(jobId);

  if (!record || isTerminalJob(record) || !isJobWorkerStale(record)) {
    return;
  }

  if (process.env.NOTIONMCP_RUN_JOBS_INLINE === "true") {
    void processJob(jobId);
    return;
  }

  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const workerScript = path.join(process.cwd(), "scripts", "run-job.ts");
  const child = spawn(process.execPath, [tsxCli, workerScript, jobId], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  child.unref();
}

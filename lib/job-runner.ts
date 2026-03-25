import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { getDurableExecutionMode } from "@/lib/deployment-boundary";
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
import { errorLog, incrementMetric, infoLog, warnLog } from "@/lib/observability";
import { runResearchAgent } from "@/lib/agent";
import { executeWriteJob, WriteExecutionError, type WriteExecutionInput } from "@/lib/write-execution";

const require = createRequire(import.meta.url);

export const jobRunnerTestOverrides: {
  runResearchAgent?: typeof runResearchAgent;
  executeWriteJob?: typeof executeWriteJob;
} = {};

export async function createDurableJob(kind: JobKind, payload: unknown): Promise<PersistedJobRecord> {
  const record = await createJob(kind, payload);
  incrementMetric("jobsCreated");
  infoLog("job-runner", "Created durable job.", {
    jobId: record.id,
    jobKind: record.kind,
  });
  return record;
}

export function getDetachedJobWorkerCommand(jobId: string, cwd = process.cwd()): {
  command: string;
  args: string[];
} {
  const tsxPackageRoot = path.dirname(require.resolve("tsx/package.json"));

  return {
    command: process.execPath,
    args: [path.join(tsxPackageRoot, "dist", "cli.mjs"), path.join(cwd, "scripts", "run-job.ts"), jobId],
  };
}

export async function processJob(jobId: string): Promise<void> {
  const record = await loadJobRecord(jobId);

  if (!record || isTerminalJob(record)) {
    return;
  }

  infoLog("job-runner", "Starting job processing.", {
    jobId,
    jobKind: record.kind,
    durableExecutionMode: getDurableExecutionMode(),
  });
  await markJobRunning(jobId, { pid: process.pid }, record.checkpoint);

  try {
    if (record.kind === "research") {
      const payload = record.payload as { prompt?: string; researchMode?: string };
      const result = await (jobRunnerTestOverrides.runResearchAgent ?? runResearchAgent)(
        payload.prompt ?? "",
        async (message, checkpoint) => {
          const mergedCheckpoint: Partial<JobCheckpoint> = {
            phase: checkpoint?.phase,
            searchQueries: checkpoint?.searchQueries,
            evidenceDocumentCount: checkpoint?.evidenceDocumentCount,
            pagesBrowsed: checkpoint?.pagesBrowsed,
          };
          await appendJobEvent(jobId, "update", { message }, mergedCheckpoint);
          await touchJobHeartbeat(jobId, mergedCheckpoint);
        },
        { researchMode: payload.researchMode }
      );

      await markJobComplete(jobId, result, {
        phase: "complete",
      });
      infoLog("job-runner", "Completed research job.", {
        jobId,
        jobKind: record.kind,
      });
      return;
    }

    const payload = record.payload as WriteExecutionInput;
    const resumedPayload: WriteExecutionInput = {
      ...payload,
      targetDatabaseId: record.checkpoint?.databaseId ?? payload.targetDatabaseId,
      resumeFromIndex: record.checkpoint?.nextRowIndex ?? payload.resumeFromIndex ?? 0,
    };
    const result = await (jobRunnerTestOverrides.executeWriteJob ?? executeWriteJob)(resumedPayload, {
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
    infoLog("job-runner", "Completed write job.", {
      jobId,
      jobKind: record.kind,
      databaseId: result.databaseId,
      nextRowIndex: result.auditTrail.rows.length + (result.resumedFromIndex ?? 0),
    });
  } catch (error) {
    if (error instanceof WriteExecutionError) {
      incrementMetric("jobFailures");
      await markJobError(jobId, error.details, {
        phase: "error",
        databaseId: error.details.databaseId,
        nextRowIndex: error.details.nextRowIndex,
        providerMode: error.details.providerMode,
      });
      errorLog("job-runner", "Write job failed with a resumable execution error.", {
        jobId,
        jobKind: record.kind,
        databaseId: error.details.databaseId,
        nextRowIndex: error.details.nextRowIndex,
        providerMode: error.details.providerMode,
      });
      return;
    }

    incrementMetric("jobFailures");
    await markJobError(jobId, {
      message: error instanceof Error ? error.message : String(error),
    });
    errorLog("job-runner", "Job failed with an unexpected error.", {
      jobId,
      jobKind: record.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function ensureJobWorker(jobId: string): Promise<void> {
  const record = await loadJobRecord(jobId);

  if (!record || isTerminalJob(record) || !isJobWorkerStale(record)) {
    return;
  }

  if (getDurableExecutionMode() === "inline") {
    if (record.status === "running") {
      incrementMetric("jobsResumed");
      warnLog("job-runner", "Restarting stale job inline.", {
        jobId,
        jobKind: record.kind,
      });
    }
    void processJob(jobId);
    return;
  }

  const workerCommand = getDetachedJobWorkerCommand(jobId);
  if (record.status === "running") {
    incrementMetric("jobsResumed");
    warnLog("job-runner", "Respawning stale detached job worker.", {
      jobId,
      jobKind: record.kind,
    });
  }
  const child = spawn(workerCommand.command, workerCommand.args, {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  child.unref();
}

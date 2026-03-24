import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendJobEvent,
  createJob,
  isJobWorkerStale,
  loadJobRecord,
  markJobComplete,
  markJobRunning,
} from "@/lib/job-store";

const ORIGINAL_ENV = { ...process.env };

test.afterEach(async () => {
  const jobDir = process.env.JOB_STATE_DIR;
  process.env.JOB_STATE_DIR = ORIGINAL_ENV.JOB_STATE_DIR;

  if (jobDir?.startsWith(path.join(os.tmpdir(), "notionmcp-jobs-"))) {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("job store persists events, checkpoints, and terminal state", async () => {
  process.env.JOB_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-jobs-"));

  const job = await createJob("research", { prompt: "Research durable jobs" });
  await markJobRunning(job.id, { pid: 1234 }, { phase: "planning" });
  await appendJobEvent(job.id, "update", { message: "Working..." }, { evidenceDocumentCount: 2 });
  await markJobComplete(job.id, { ok: true }, { phase: "complete" });

  const loaded = await loadJobRecord(job.id);

  assert.ok(loaded);
  assert.equal(loaded?.status, "complete");
  assert.equal(loaded?.checkpoint?.phase, "complete");
  assert.equal(loaded?.checkpoint?.evidenceDocumentCount, 2);
  assert.equal(loaded?.events.length, 2);
  assert.deepEqual(loaded?.result, { ok: true });
});

test("queued and stale running jobs are restartable", async () => {
  process.env.JOB_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-jobs-"));

  const queuedJob = await createJob("write", { suggestedDbTitle: "Research" });
  assert.equal(isJobWorkerStale(queuedJob), true);

  const runningJob = await markJobRunning(queuedJob.id, { pid: 1234 });
  assert.equal(isJobWorkerStale(runningJob, Date.parse(runningJob.updatedAt) + 20000), true);
});

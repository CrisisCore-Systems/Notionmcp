import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
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
  process.env.JOB_STATE_RETENTION_DAYS = ORIGINAL_ENV.JOB_STATE_RETENTION_DAYS;
  process.env.PERSISTED_STATE_ENCRYPTION_KEY = ORIGINAL_ENV.PERSISTED_STATE_ENCRYPTION_KEY;

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

test("job store expires files beyond the retention window", async () => {
  process.env.JOB_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-jobs-"));
  process.env.JOB_STATE_RETENTION_DAYS = "1";

  const expiredJob = await createJob("research", { prompt: "Old job" });
  const expiredJobPath = path.join(process.env.JOB_STATE_DIR, `${expiredJob.id}.json`);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(expiredJobPath, twoDaysAgo, twoDaysAgo);

  await createJob("research", { prompt: "Fresh job" });

  assert.equal(await loadJobRecord(expiredJob.id), null);
});

test("job store encrypts persisted state when configured", async () => {
  process.env.JOB_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-jobs-"));
  process.env.PERSISTED_STATE_ENCRYPTION_KEY = "operator-secret";

  const job = await createJob("research", { prompt: "Encrypted durable jobs" });
  const rawFile = await readFile(path.join(process.env.JOB_STATE_DIR, `${job.id}.json`), "utf8");
  const loaded = await loadJobRecord(job.id);

  assert.match(rawFile, /notionmcp-encrypted-state\/v1/);
  assert.doesNotMatch(rawFile, /Encrypted durable jobs/);
  assert.equal((loaded?.payload as { prompt?: string }).prompt, "Encrypted durable jobs");
});

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDetachedJobWorkerCommand } from "@/lib/job-runner";
import {
  appendJobEvent,
  buildJobStateUrl,
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
  process.env.APP_ALLOWED_ORIGIN = ORIGINAL_ENV.APP_ALLOWED_ORIGIN;
  process.env.APP_ACCESS_TOKEN = ORIGINAL_ENV.APP_ACCESS_TOKEN;

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
  assert.ok(loaded?.integrity?.recordHash);
  assert.ok(loaded?.integrity?.mac);
  assert.ok(loaded?.integrity?.keyId);
  assert.ok(loaded?.integrity?.signedAt);
  assert.ok(loaded?.events[0]?.eventHash);
  assert.equal(loaded?.events[1]?.previousEventHash, loaded?.events[0]?.eventHash);
  assert.equal(loaded?.integrity?.finalEventChainHash, loaded?.events.at(-1)?.eventHash);
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

test("job store detects tampering with persisted artifacts", async () => {
  process.env.JOB_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-jobs-"));

  const job = await createJob("research", { prompt: "Integrity-sensitive job" });
  await markJobRunning(job.id, { pid: 1234 }, { phase: "planning" });
  const jobPath = path.join(process.env.JOB_STATE_DIR, `${job.id}.json`);
  const parsed = JSON.parse(await readFile(jobPath, "utf8")) as
    | {
        format: string;
        ciphertext: string;
      }
    | {
        integrity: {
          mac: string;
        };
      };

  if ("format" in parsed) {
    parsed.ciphertext = `A${parsed.ciphertext.slice(1)}`;
  } else {
    // HMAC-SHA256 digests are 64 hex chars; replacing one character keeps the shape but breaks validation.
    parsed.integrity.mac = `${"0".repeat(63)}1`;
  }

  await writeFile(jobPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await assert.rejects(async () => await loadJobRecord(job.id));
});

test("detached job workers resolve the shipped TS entrypoint through the runtime tsx CLI", async () => {
  const jobId = "11111111-1111-1111-1111-111111111111";
  const workerCommand = getDetachedJobWorkerCommand(jobId);

  assert.equal(workerCommand.command, process.execPath);
  assert.match(workerCommand.args[0] ?? "", /tsx[\\/]dist[\\/]cli\.mjs$/);
  assert.equal(workerCommand.args[1], path.join(process.cwd(), "scripts", "run-job.ts"));
  assert.equal(workerCommand.args[2], jobId);
  await access(workerCommand.args[1]);
});

test("job store requires persisted state encryption in remote private mode", async () => {
  process.env.JOB_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-jobs-"));
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  process.env.APP_ACCESS_TOKEN = "secret-token";
  process.env.PERSISTED_STATE_ENCRYPTION_KEY = "";

  await assert.rejects(
    createJob("research", { prompt: "Remote job" }),
    /PERSISTED_STATE_ENCRYPTION_KEY/
  );
});

test("buildJobStateUrl returns the API path for persisted job JSON", () => {
  const jobId = "11111111-1111-1111-1111-111111111111";

  assert.equal(buildJobStateUrl(jobId), `/api/jobs/${jobId}`);
});

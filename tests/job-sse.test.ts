import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJobEventStream } from "@/lib/job-sse";
import { appendJobEvent, createJob, markJobRunning } from "@/lib/job-store";

const ORIGINAL_ENV = { ...process.env };

async function readStream(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      output += decoder.decode();
      return output;
    }

    output += decoder.decode(value, { stream: true });
  }
}

test.afterEach(async () => {
  const jobDir = process.env.JOB_STATE_DIR;
  process.env.JOB_STATE_DIR = ORIGINAL_ENV.JOB_STATE_DIR;

  if (jobDir?.startsWith(path.join(os.tmpdir(), "notionmcp-jobs-"))) {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("job SSE replays only missed events and includes resume checkpoint metadata", async () => {
  process.env.JOB_STATE_DIR = await mkdtemp(path.join(os.tmpdir(), "notionmcp-jobs-"));

  const job = await createJob("write", { suggestedDbTitle: "Research" });
  await markJobRunning(job.id, { pid: 1234 }, {
    phase: "writing",
    databaseId: "db_123",
    nextRowIndex: 2,
  });
  await appendJobEvent(job.id, "update", { message: "row 2 confirmed" }, { nextRowIndex: 3 });
  await appendJobEvent(job.id, "update", { message: "row 3 confirmed" }, { nextRowIndex: 4 });

  const output = await readStream(createJobEventStream(job.id, { afterEventId: 1, streamWindowMs: 1 }));

  assert.match(output, /event: job/);
  assert.match(output, /"databaseId":"db_123"/);
  assert.match(output, /"nextRowIndex":4/);
  assert.doesNotMatch(output, /row 2 confirmed/);
  assert.match(output, /row 3 confirmed/);
  assert.match(output, /event: continue/);
  assert.match(output, /"afterEventId":2/);
});

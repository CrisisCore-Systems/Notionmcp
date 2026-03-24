import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeSSEChunk,
  createSSEParserState,
} from "@/app/components/chat/stream";

test("consumeSSEChunk handles event and data split across chunks", () => {
  const updates: string[] = [];
  let parsed = consumeSSEChunk(createSSEParserState(), "event: update\n", (message) => {
    updates.push(message);
  });

  parsed = consumeSSEChunk(
    parsed.state,
    'data: {"message":"Working..."}\n\nevent: complete\n',
    (message) => {
      updates.push(message);
    }
  );
  parsed = consumeSSEChunk(parsed.state, 'data: {"ok":true}\n\n', (message) => {
    updates.push(message);
  });

  assert.deepEqual(updates, ["Working..."]);
  assert.deepEqual(parsed.complete, { ok: true });
});

test("consumeSSEChunk returns structured error details", () => {
  const parsed = consumeSSEChunk(
    createSSEParserState(),
    'event: error\ndata: {"message":"boom","nextRowIndex":2}\n\n',
    () => undefined
  );

  assert.ok(parsed.error);
  assert.equal(parsed.error?.message, "boom");
  assert.deepEqual(parsed.error?.details, { message: "boom", nextRowIndex: 2 });
});

test("consumeSSEChunk surfaces job metadata and reconnect instructions", () => {
  const jobEvent = consumeSSEChunk(
    createSSEParserState(),
    'event: job\ndata: {"jobId":"job-123","kind":"research"}\n\n',
    () => undefined
  );
  const reconnectEvent = consumeSSEChunk(
    createSSEParserState(),
    'event: continue\ndata: {"jobId":"job-123","afterEventId":4}\n\n',
    () => undefined
  );

  assert.deepEqual(jobEvent.event, {
    name: "job",
    data: {
      jobId: "job-123",
      kind: "research",
    },
  });
  assert.deepEqual(reconnectEvent.continue, {
    jobId: "job-123",
    afterEventId: 4,
  });
});

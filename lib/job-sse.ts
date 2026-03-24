import { isTerminalJob, loadJobRecord, type PersistedJobRecord } from "@/lib/job-store";

const DEFAULT_STREAM_WINDOW_MS = 25000;
const POLL_INTERVAL_MS = 300;

function encodeSse(encoder: TextEncoder, event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function wait(delayMs: number) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createJobEventStream(
  jobId: string,
  options: {
    afterEventId?: number;
    streamWindowMs?: number;
  } = {}
): ReadableStream {
  const afterEventId = options.afterEventId ?? 0;
  const streamWindowMs = options.streamWindowMs ?? DEFAULT_STREAM_WINDOW_MS;
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const startedAt = Date.now();
      let lastEventId = afterEventId;

      const emitRecordEvents = (record: PersistedJobRecord) => {
        for (const event of record.events) {
          if (event.id <= lastEventId) {
            continue;
          }

          controller.enqueue(encodeSse(encoder, event.event, event.data));
          lastEventId = event.id;
        }
      };

      try {
        const initialRecord = await loadJobRecord(jobId);

        if (!initialRecord) {
          controller.enqueue(encodeSse(encoder, "error", { message: `Job "${jobId}" was not found.` }));
          return;
        }

        controller.enqueue(
          encodeSse(encoder, "job", {
            jobId: initialRecord.id,
            kind: initialRecord.kind,
            status: initialRecord.status,
            checkpoint: initialRecord.checkpoint,
          })
        );
        emitRecordEvents(initialRecord);

        if (isTerminalJob(initialRecord)) {
          return;
        }

        while (Date.now() - startedAt < streamWindowMs) {
          await wait(POLL_INTERVAL_MS);
          const nextRecord = await loadJobRecord(jobId);

          if (!nextRecord) {
            controller.enqueue(encodeSse(encoder, "error", { message: `Job "${jobId}" was not found.` }));
            return;
          }

          emitRecordEvents(nextRecord);

          if (isTerminalJob(nextRecord)) {
            return;
          }
        }

        controller.enqueue(
          encodeSse(encoder, "continue", {
            jobId,
            afterEventId: lastEventId,
          })
        );
      } finally {
        controller.close();
      }
    },
  });
}

export function createJobEventStreamResponse(
  jobId: string,
  options: {
    afterEventId?: number;
    streamWindowMs?: number;
  } = {}
): Response {
  return new Response(createJobEventStream(jobId, options), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

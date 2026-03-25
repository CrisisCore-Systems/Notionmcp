import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  consumeSSEChunk,
  createSSEParserState,
  type SSEParserState,
} from "@/app/components/chat/stream";

export function createPostRequest(url: string, body: unknown, headers?: HeadersInit) {
  const requestHeaders = new Headers({
    "content-type": "application/json",
    host: new URL(url).host,
    ...headers,
  });

  return new NextRequest(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

export function createGetRequest(url: string, headers?: HeadersInit) {
  const requestHeaders = new Headers({
    host: new URL(url).host,
    ...headers,
  });

  return new NextRequest(url, {
    method: "GET",
    headers: requestHeaders,
  });
}

export function consumeAllSseMessages(
  state: SSEParserState,
  chunk: string,
  updates: string[]
): {
  state: SSEParserState;
  parsed: Array<ReturnType<typeof consumeSSEChunk>>;
} {
  const parsed: Array<ReturnType<typeof consumeSSEChunk>> = [];
  let nextState = state;
  let nextChunk = chunk;

  while (true) {
    const result = consumeSSEChunk(nextState, nextChunk, (message) => {
      updates.push(message);
    });
    nextState = result.state;
    nextChunk = "";

    if (result.event || result.complete !== undefined || result.continue || result.error) {
      parsed.push(result);
      continue;
    }

    return { state: nextState, parsed };
  }
}

export async function collectSseResponse(response: Response): Promise<{
  updates: string[];
  events: Array<{ name: string; data: unknown }>;
  complete?: unknown;
  reconnect?: { jobId: string; afterEventId: number };
  error?: Error;
}> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const updates: string[] = [];
  const events: Array<{ name: string; data: unknown }> = [];
  let complete: unknown;
  let reconnect: { jobId: string; afterEventId: number } | undefined;
  let state = createSSEParserState();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      return { updates, events, complete, reconnect };
    }

    const consumed = consumeAllSseMessages(state, decoder.decode(value, { stream: true }), updates);
    state = consumed.state;

    for (const parsed of consumed.parsed) {
      if (parsed.error) {
        return { updates, events, complete, reconnect, error: parsed.error };
      }

      if (parsed.event) {
        events.push(parsed.event);
      }

      if (parsed.complete !== undefined) {
        complete = parsed.complete;
      }

      if (parsed.continue) {
        reconnect = parsed.continue;
      }
    }
  }
}

export async function openSseUntil(
  response: Response,
  predicate: (context: { updates: string[]; jobId: string }) => boolean
): Promise<{
  updates: string[];
  jobId: string;
  afterEventId: number;
}> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const updates: string[] = [];
  let jobId = "";
  let parserState = createSSEParserState();

  while (!predicate({ updates, jobId })) {
    const { done, value } = await reader.read();
    assert.equal(done, false);

    const consumed = consumeAllSseMessages(parserState, decoder.decode(value, { stream: true }), updates);
    parserState = consumed.state;

    for (const parsed of consumed.parsed) {
      if (parsed.error) {
        throw parsed.error;
      }

      if (parsed.event?.name === "job") {
        jobId = ((parsed.event.data as { jobId?: string }).jobId ?? "").trim();
      }
    }
  }

  await reader.cancel();

  return {
    updates,
    jobId,
    afterEventId: updates.length,
  };
}

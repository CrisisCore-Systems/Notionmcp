import type { StreamErrorPayload } from "./types";

type StreamSSEOptions = {
  url: string;
  body: unknown;
  signal: AbortSignal;
  accessToken?: string;
  onUpdate: (message: string) => void;
  onEvent?: (event: string, data: unknown) => void;
};

export type SSEParserState = {
  buffer: string;
  pendingEvent: string;
};

function buildRequestHeaders(accessToken?: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const trimmedToken = accessToken?.trim();

  if (trimmedToken) {
    headers["x-app-access-token"] = trimmedToken;
  }

  return headers;
}

export function createSSEParserState(): SSEParserState {
  return {
    buffer: "",
    pendingEvent: "",
  };
}

export function consumeSSEChunk(
  state: SSEParserState,
  chunk: string,
  onUpdate: (message: string) => void
): {
  state: SSEParserState;
  complete?: unknown;
  continue?: { jobId: string; afterEventId: number };
  event?: { name: string; data: unknown };
  error?: Error & { details?: StreamErrorPayload };
} {
  let buffer = state.buffer + chunk;
  let pendingEvent = state.pendingEvent;

  while (true) {
    const newlineIndex = buffer.indexOf("\n");

    if (newlineIndex === -1) {
      break;
    }

    const rawLine = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (!line) {
      pendingEvent = "";
      continue;
    }

    if (line.startsWith("event: ")) {
      pendingEvent = line.slice(7).trim();
      continue;
    }

    if (!line.startsWith("data: ")) {
      continue;
    }

    const data = JSON.parse(line.slice(6));

    if (pendingEvent === "update") {
      onUpdate((data as { message?: string }).message ?? "");
      continue;
    }

    if (pendingEvent === "job") {
      return {
        state: { buffer, pendingEvent: "" },
        event: {
          name: "job",
          data,
        },
      };
    }

    if (pendingEvent === "continue") {
      return {
        state: { buffer, pendingEvent: "" },
        continue: {
          jobId: (data as { jobId?: string }).jobId ?? "",
          afterEventId: (data as { afterEventId?: number }).afterEventId ?? 0,
        },
      };
    }

    if (pendingEvent === "complete") {
      return {
        state: { buffer, pendingEvent: "" },
        complete: data,
      };
    }

    if (pendingEvent === "error") {
      const error = new Error((data as { message?: string }).message ?? "Streaming request failed.") as Error & {
        details?: StreamErrorPayload;
      };
      error.details = data as StreamErrorPayload;
      return {
        state: { buffer, pendingEvent: "" },
        error,
      };
    }
  }

  return {
    state: { buffer, pendingEvent },
  };
}

export async function streamSSE({
  url,
  body,
  signal,
  accessToken,
  onUpdate,
  onEvent,
}: StreamSSEOptions): Promise<unknown> {
  while (true) {
    const res = await fetch(url, {
      method: "POST",
      headers: buildRequestHeaders(accessToken),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      let message = text || `Request failed with status ${res.status}`;

      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // Fall back to the raw response text when the error body is not valid JSON or cannot be parsed.
      }

      throw new Error(message);
    }

    if (!res.body) {
      throw new Error("Streaming response was empty.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let state = createSSEParserState();

    let shouldReconnect = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const parsed = consumeSSEChunk(state, decoder.decode(value, { stream: true }), onUpdate);
      state = parsed.state;

      if (parsed.event) {
        onEvent?.(parsed.event.name, parsed.event.data);
        continue;
      }

      if (parsed.complete !== undefined) {
        return parsed.complete;
      }

      if (parsed.continue) {
        body = {
          ...(typeof body === "object" && body && !Array.isArray(body) ? body : {}),
          jobId: parsed.continue.jobId,
          afterEventId: parsed.continue.afterEventId,
        };
        shouldReconnect = true;
        break;
      }

      if (parsed.error) {
        throw parsed.error;
      }
    }

    if (shouldReconnect) {
      continue;
    }

    throw new Error(
      "Streaming response ended unexpectedly before completion. Please try again."
    );
  }
}

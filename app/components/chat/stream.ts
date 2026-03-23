import type { StreamErrorPayload } from "./types";

type StreamSSEOptions = {
  url: string;
  body: unknown;
  signal: AbortSignal;
  accessToken?: string;
  onUpdate: (message: string) => void;
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

export async function streamSSE({
  url,
  body,
  signal,
  accessToken,
  onUpdate,
}: StreamSSEOptions): Promise<unknown> {
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
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let event = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6));
        if (event === "update") onUpdate(data.message);
        else if (event === "complete") return data;
        else if (event === "error") {
          const error = new Error(data.message) as Error & {
            details?: StreamErrorPayload;
          };
          error.details = data as StreamErrorPayload;
          throw error;
        }
      }
    }
  }

  throw new Error(
    "Streaming response ended unexpectedly before completion. Please try again."
  );
}

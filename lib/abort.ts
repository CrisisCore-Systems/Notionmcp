export function createAbortError(message = "Request cancelled by client."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  message = "Request cancelled by client."
): void {
  if (signal?.aborted) {
    throw createAbortError(message);
  }
}

export function onAbort(
  signal: AbortSignal | undefined,
  callback: () => void
): () => void {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    callback();
    return () => {};
  }

  const handler = () => callback();
  signal.addEventListener("abort", handler, { once: true });
  return () => signal.removeEventListener("abort", handler);
}

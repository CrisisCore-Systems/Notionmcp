import { createAbortError, isAbortError, throwIfAborted } from "./abort";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 750;

const TRANSIENT_ERROR_PATTERNS = [
  "transport",
  "disconnected",
  "connection reset",
  "econnreset",
  "broken pipe",
  "socket hang up",
  "timed out",
  "timeout",
  "etimedout",
  "eai_again",
  "temporarily unavailable",
  "temporary failure",
  "too many requests",
  "rate limit",
  "429",
  "500",
  "502",
  "503",
  "504",
  "bad gateway",
  "service unavailable",
  "upstream",
];

const PERMANENT_4XX_STATUS_PATTERNS = [
  /\bstatus(?: code)?\s*(?:=|:)?\s*(4\d\d)\b/i,
  /\bhttp\s*(4\d\d)\b/i,
  /"status"\s*:\s*(4\d\d)\b/i,
];

const PERMANENT_ERROR_PATTERNS = [
  "validation failed",
  "schema validation",
  "invalid schema",
  "bad request",
  "unauthorized",
  "forbidden",
  "authentication failed",
  "invalid api key",
  "permission denied",
  "missing required",
];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(createAbortError());
    };

    signal.addEventListener("abort", abort, { once: true });
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStatusCodeValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    return Number(value);
  }

  return undefined;
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const seen = new Set<object>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const candidate = queue.shift();

    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    const record = candidate as Record<string, unknown>;

    for (const key of ["status", "statusCode"]) {
      const statusCode = getStatusCodeValue(record[key]);

      if (statusCode) {
        return statusCode;
      }
    }

    queue.push(record.response, record.cause);
  }

  return undefined;
}

export function isRetryableUpstreamError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const statusCode = getErrorStatusCode(error);

  if (statusCode != null) {
    if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
      return true;
    }

    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
  }

  for (const pattern of PERMANENT_4XX_STATUS_PATTERNS) {
    const parsedStatusCode = Number(pattern.exec(message)?.[1]);

    if (!Number.isFinite(parsedStatusCode)) {
      continue;
    }

    if (
      parsedStatusCode >= 400 &&
      parsedStatusCode < 500 &&
      parsedStatusCode !== 408 &&
      parsedStatusCode !== 429
    ) {
      return false;
    }
  }

  if (PERMANENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern))) {
    return false;
  }

  return TRANSIENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

export async function runWithRetry<T>(
  operation: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    signal?: AbortSignal;
  }
): Promise<{ attempt: number; value: T }> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let attempt = 0;

  while (attempt < maxAttempts) {
    throwIfAborted(options?.signal);
    attempt += 1;

    try {
      const value = await operation();
      return { attempt, value };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const shouldRetry = options?.shouldRetry?.(error, attempt) ?? true;

      if (attempt >= maxAttempts || !shouldRetry) {
        throw error;
      }

      await sleep(retryDelayMs * 2 ** (attempt - 1), options?.signal);
    }
  }

  throw new Error(`Operation failed after ${maxAttempts} attempts.`);
}

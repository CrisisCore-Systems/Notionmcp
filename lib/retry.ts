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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableUpstreamError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();

  for (const pattern of PERMANENT_4XX_STATUS_PATTERNS) {
    const statusCode = Number(pattern.exec(message)?.[1]);

    if (!Number.isFinite(statusCode)) {
      continue;
    }

    if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
      return false;
    }
  }

  return TRANSIENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

export async function runWithRetry<T>(
  operation: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  }
): Promise<{ attempt: number; value: T }> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      const value = await operation();
      return { attempt, value };
    } catch (error) {
      const shouldRetry = options?.shouldRetry?.(error, attempt) ?? true;

      if (attempt >= maxAttempts || !shouldRetry) {
        throw error;
      }

      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }

  throw new Error(`Operation failed after ${maxAttempts} attempts.`);
}

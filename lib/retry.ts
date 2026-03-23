const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 750;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWithRetry<T>(
  operation: () => Promise<T>,
  options?: { maxAttempts?: number; retryDelayMs?: number }
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
      if (attempt >= maxAttempts) {
        throw error;
      }

      await sleep(retryDelayMs * attempt);
    }
  }

  throw new Error(`Operation failed after ${maxAttempts} attempts.`);
}

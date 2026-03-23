import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableUpstreamError, runWithRetry } from "@/lib/retry";

test("isRetryableUpstreamError distinguishes transient from permanent upstream failures", () => {
  assert.equal(isRetryableUpstreamError(new Error("Notion transport disconnected")), true);
  assert.equal(isRetryableUpstreamError(new Error("HTTP status 429 from upstream")), true);
  assert.equal(isRetryableUpstreamError(new Error("HTTP status 422 validation failed")), false);
  assert.equal(isRetryableUpstreamError({ status: 503, message: "Gateway timeout" }), true);
  assert.equal(
    isRetryableUpstreamError({ response: { status: 401 }, message: "Unauthorized request" }),
    false
  );
  assert.equal(isRetryableUpstreamError(new Error("Schema validation failed for payload")), false);
});

test("runWithRetry stops immediately for permanent errors when shouldRetry returns false", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      runWithRetry(
        async () => {
          attempts += 1;
          throw new Error("HTTP status 422 validation failed");
        },
        {
          maxAttempts: 3,
          retryDelayMs: 1,
          shouldRetry: (error) => isRetryableUpstreamError(error),
        }
      ),
    /422/
  );

  assert.equal(attempts, 1);
});

test("runWithRetry aborts during backoff before scheduling another retry", async () => {
  const controller = new AbortController();
  let attempts = 0;

  setTimeout(() => controller.abort(), 5);

  await assert.rejects(
    () =>
      runWithRetry(
        async () => {
          attempts += 1;
          throw new Error("HTTP status 503 from upstream");
        },
        {
          maxAttempts: 3,
          retryDelayMs: 50,
          shouldRetry: (error) => isRetryableUpstreamError(error),
          signal: controller.signal,
        }
      ),
    /cancelled by client/i
  );

  assert.equal(attempts, 1);
});

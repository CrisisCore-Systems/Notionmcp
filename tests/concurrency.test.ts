import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrencyLimit } from "@/lib/concurrency";

test("mapWithConcurrencyLimit preserves order while bounding active work", async () => {
  let activeCount = 0;
  let maxActiveCount = 0;

  const results = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (value) => {
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);

    await new Promise((resolve) => setTimeout(resolve, 5));

    activeCount -= 1;
    return value * 10;
  });

  assert.deepEqual(results, [10, 20, 30, 40]);
  assert.equal(maxActiveCount, 2);
});

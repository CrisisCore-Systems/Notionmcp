import assert from "node:assert/strict";
import test from "node:test";
import {
  areDurableJobsEnabled,
  getDurableJobsWarning,
} from "@/lib/deployment-boundary";

test("getDurableJobsWarning returns a runtime warning when detached durable jobs are enabled", () => {
  const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
  const warning = getDurableJobsWarning(env);

  assert.equal(areDurableJobsEnabled(env), true);
  assert.ok(warning);
  assert.match(warning?.title ?? "", /long-lived Node host/i);
});

test("getDurableJobsWarning stays quiet when inline jobs are explicitly enabled", () => {
  const env = { NODE_ENV: "test", NOTIONMCP_RUN_JOBS_INLINE: "true" } as NodeJS.ProcessEnv;

  assert.equal(areDurableJobsEnabled(env), false);
  assert.equal(getDurableJobsWarning(env), null);
});

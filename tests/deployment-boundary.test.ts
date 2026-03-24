import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDeploymentReadiness,
  areDurableJobsEnabled,
  getDeploymentReadinessError,
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

test("remote private mode requires persisted state encryption before boot", () => {
  const env = {
    NODE_ENV: "test",
    APP_ALLOWED_ORIGIN: "https://app.example.com",
    APP_ACCESS_TOKEN: "secret-token",
  } as NodeJS.ProcessEnv;

  assert.match(getDeploymentReadinessError(env) ?? "", /PERSISTED_STATE_ENCRYPTION_KEY/);
  assert.throws(() => assertDeploymentReadiness(env), /PERSISTED_STATE_ENCRYPTION_KEY/);
});

test("local mode stays permissive without persisted state encryption", () => {
  const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

  assert.equal(getDeploymentReadinessError(env), null);
  assert.doesNotThrow(() => assertDeploymentReadiness(env));
});

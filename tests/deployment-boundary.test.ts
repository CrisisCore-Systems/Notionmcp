import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDeploymentReadiness,
  areDurableJobsEnabled,
  getDeploymentMode,
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

test("deployment mode infers remote private host when remote access settings are present", () => {
  const env = {
    NODE_ENV: "test",
    APP_ALLOWED_ORIGIN: "https://app.example.com",
    APP_ACCESS_TOKEN: "secret-token",
    PERSISTED_STATE_ENCRYPTION_KEY: "operator-secret",
  } as NodeJS.ProcessEnv;

  assert.equal(getDeploymentMode(env), "remote-private-host");
  assert.doesNotThrow(() => assertDeploymentReadiness(env));
});

test("explicit remote private host mode requires remote access settings and detached jobs", () => {
  const missingRemoteConfig = {
    NODE_ENV: "test",
    NOTIONMCP_DEPLOYMENT_MODE: "remote-private-host",
    PERSISTED_STATE_ENCRYPTION_KEY: "operator-secret",
  } as NodeJS.ProcessEnv;
  const inlineRemoteConfig = {
    NODE_ENV: "test",
    NOTIONMCP_DEPLOYMENT_MODE: "remote-private-host",
    APP_ALLOWED_ORIGIN: "https://app.example.com",
    APP_ACCESS_TOKEN: "secret-token",
    PERSISTED_STATE_ENCRYPTION_KEY: "operator-secret",
    NOTIONMCP_RUN_JOBS_INLINE: "true",
  } as NodeJS.ProcessEnv;

  assert.match(getDeploymentReadinessError(missingRemoteConfig) ?? "", /APP_ALLOWED_ORIGIN/);
  assert.match(getDeploymentReadinessError(inlineRemoteConfig) ?? "", /NOTIONMCP_RUN_JOBS_INLINE/);
});

test("local mode stays permissive without persisted state encryption", () => {
  const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

  assert.equal(getDeploymentMode(env), "localhost-operator");
  assert.equal(getDeploymentReadinessError(env), null);
  assert.doesNotThrow(() => assertDeploymentReadiness(env));
});

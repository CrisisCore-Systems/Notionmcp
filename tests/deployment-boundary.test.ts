import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertDeploymentReadiness,
  assertDurabilityExecutionReadiness,
  areDurableJobsEnabled,
  getDurableExecutionMode,
  getDeploymentMode,
  getDeploymentReadinessError,
  getDurableJobsWarning,
} from "@/lib/deployment-boundary";

const ORIGINAL_ENV = { ...process.env };

test.afterEach(async () => {
  const jobDir = process.env.JOB_STATE_DIR;
  const auditDir = process.env.WRITE_AUDIT_DIR;
  process.env = { ...ORIGINAL_ENV };

  for (const directory of [jobDir, auditDir]) {
    if (
      directory &&
      (directory.startsWith(path.join(os.tmpdir(), "notionmcp-jobs-")) ||
        directory.startsWith(path.join(os.tmpdir(), "notionmcp-audits-")))
    ) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

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

test("inline-only host durability intentionally degrades localhost jobs to inline mode", () => {
  const env = {
    NODE_ENV: "test",
    NOTIONMCP_HOST_DURABILITY: "inline-only",
  } as NodeJS.ProcessEnv;

  assert.equal(getDurableExecutionMode(env), "inline");
  assert.equal(areDurableJobsEnabled(env), false);
  assert.match(getDurableJobsWarning(env)?.message ?? "", /degrade to in-process jobs/i);
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
  const inlineOnlyHostRemoteConfig = {
    NODE_ENV: "test",
    NOTIONMCP_DEPLOYMENT_MODE: "remote-private-host",
    APP_ALLOWED_ORIGIN: "https://app.example.com",
    APP_ACCESS_TOKEN: "secret-token",
    PERSISTED_STATE_ENCRYPTION_KEY: "operator-secret",
    NOTIONMCP_HOST_DURABILITY: "inline-only",
  } as NodeJS.ProcessEnv;

  assert.match(getDeploymentReadinessError(missingRemoteConfig) ?? "", /APP_ALLOWED_ORIGIN/);
  assert.match(getDeploymentReadinessError(inlineRemoteConfig) ?? "", /NOTIONMCP_RUN_JOBS_INLINE/);
  assert.match(getDeploymentReadinessError(inlineOnlyHostRemoteConfig) ?? "", /inline-only/);
});

test("local mode stays permissive without persisted state encryption", () => {
  const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

  assert.equal(getDeploymentMode(env), "localhost-operator");
  assert.equal(getDeploymentReadinessError(env), null);
  assert.doesNotThrow(() => assertDeploymentReadiness(env));
});

test("durability readiness requires writable persisted directories", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "notionmcp-jobs-"));
  const jobFile = path.join(baseDir, "job-file");
  const auditDir = await mkdtemp(path.join(os.tmpdir(), "notionmcp-audits-"));
  await writeFile(jobFile, "occupied", "utf8");
  process.env.JOB_STATE_DIR = jobFile;
  process.env.WRITE_AUDIT_DIR = auditDir;

  await assert.rejects(
    assertDurabilityExecutionReadiness({ requireWriteAudit: true }),
    /Persisted job-state directory is not writable/
  );
});

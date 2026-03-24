import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getJobDirectory } from "@/lib/job-store";
import { getPersistedStateEncryptionRequirementError } from "@/lib/persisted-state";
import { getWriteAuditDirectory } from "@/lib/write-audit-store";

export type DeploymentMode = "localhost-operator" | "remote-private-host";
export type DurableExecutionMode = "detached" | "inline";
type HostDurabilityMode = "detached-persistent" | "inline-only";

const DURABLE_JOBS_WARNING_TITLE = "Durable jobs require a long-lived Node host.";
const DURABLE_JOBS_WARNING_MESSAGE =
  "Detached job workers and resumable state assume this app stays on a long-lived Node process with persistent local storage. Do not treat the default durable-jobs mode like a stateless hobby deploy.";
const INLINE_ONLY_HOST_WARNING_TITLE = "Detached durable jobs are disabled on this host.";
const INLINE_ONLY_HOST_WARNING_MESSAGE =
  "This host is marked inline-only, so the app will intentionally degrade to in-process jobs instead of pretending detached durable workers are available.";

let durableJobsWarningEmitted = false;

function hasConfiguredValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function normalizeDeploymentMode(value: string | undefined): DeploymentMode {
  const normalized = value?.trim().toLowerCase();

  if (
    normalized === "remote-private-host" ||
    normalized === "remote" ||
    normalized === "private-remote"
  ) {
    return "remote-private-host";
  }

  return "localhost-operator";
}

export function getDeploymentMode(env: NodeJS.ProcessEnv = process.env): DeploymentMode {
  if (hasConfiguredValue(env.NOTIONMCP_DEPLOYMENT_MODE)) {
    return normalizeDeploymentMode(env.NOTIONMCP_DEPLOYMENT_MODE);
  }

  return "localhost-operator";
}

function normalizeHostDurabilityMode(value: string | undefined): HostDurabilityMode {
  const normalized = value?.trim().toLowerCase();

  if (
    normalized === "inline-only" ||
    normalized === "inline" ||
    normalized === "ephemeral" ||
    normalized === "stateless"
  ) {
    return "inline-only";
  }

  return "detached-persistent";
}

export function getHostDurabilityMode(env: NodeJS.ProcessEnv = process.env): HostDurabilityMode {
  return normalizeHostDurabilityMode(env.NOTIONMCP_HOST_DURABILITY);
}

export function getDurableExecutionMode(env: NodeJS.ProcessEnv = process.env): DurableExecutionMode {
  if (env.NOTIONMCP_RUN_JOBS_INLINE?.trim().toLowerCase() === "true") {
    return "inline";
  }

  return getHostDurabilityMode(env) === "inline-only" ? "inline" : "detached";
}

export function areDurableJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDurableExecutionMode(env) === "detached";
}

export function getDurableJobsWarning(
  env: NodeJS.ProcessEnv = process.env
): { title: string; message: string } | null {
  if (env.NOTIONMCP_RUN_JOBS_INLINE?.trim().toLowerCase() === "true") {
    return null;
  }

  if (getHostDurabilityMode(env) === "inline-only") {
    return {
      title: INLINE_ONLY_HOST_WARNING_TITLE,
      message: INLINE_ONLY_HOST_WARNING_MESSAGE,
    };
  }

  return {
    title: DURABLE_JOBS_WARNING_TITLE,
    message: DURABLE_JOBS_WARNING_MESSAGE,
  };
}

export function getDeploymentReadinessError(env: NodeJS.ProcessEnv = process.env): string | null {
  const deploymentMode = getDeploymentMode(env);
  const remoteAccessConfigured =
    hasConfiguredValue(env.APP_ALLOWED_ORIGIN) || hasConfiguredValue(env.APP_ACCESS_TOKEN);

  if (remoteAccessConfigured && deploymentMode !== "remote-private-host") {
    return (
      "Remote API settings require NOTIONMCP_DEPLOYMENT_MODE=remote-private-host so workstation and deployment " +
      "guarantees stay explicit. Unset APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN to remain in localhost-operator mode."
    );
  }

  if (deploymentMode === "remote-private-host") {
    if (!hasConfiguredValue(env.APP_ALLOWED_ORIGIN) || !hasConfiguredValue(env.APP_ACCESS_TOKEN)) {
      return "Remote private host mode requires both APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN before the app will boot.";
    }

    if (getHostDurabilityMode(env) === "inline-only") {
      return (
        "Remote private host mode requires a host that can keep detached workers alive and persist local state. " +
        "Unset NOTIONMCP_HOST_DURABILITY=inline-only or move this deployment back to localhost-operator mode."
      );
    }

    if (!areDurableJobsEnabled(env)) {
      return (
        "Remote private host mode requires detached durable jobs. Leave NOTIONMCP_RUN_JOBS_INLINE unset " +
        "so persisted resumable workers stay enabled."
      );
    }
  }

  return getPersistedStateEncryptionRequirementError(env);
}

export function assertDeploymentReadiness(env: NodeJS.ProcessEnv = process.env): void {
  const error = getDeploymentReadinessError(env);

  if (error) {
    throw new Error(error);
  }
}

export function warnIfDurableJobsNeedLongLivedHost(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.warn
): void {
  const warning = getDurableJobsWarning(env);

  if (!warning || durableJobsWarningEmitted) {
    return;
  }

  durableJobsWarningEmitted = true;
  const remoteModeSuffix = getDeploymentMode(env) === "remote-private-host"
    ? " Remote private host mode also requires APP_ALLOWED_ORIGIN, APP_ACCESS_TOKEN, and PERSISTED_STATE_ENCRYPTION_KEY."
    : "";
  log(`[deployment-boundary] ${warning.title} ${warning.message}${remoteModeSuffix}`);
}

async function assertWritablePersistenceDirectory(directory: string, label: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
    const probePath = path.join(directory, `.notionmcp-readiness-${process.pid}-${Date.now()}.tmp`);
    await writeFile(probePath, `${label} readiness probe\n`, "utf8");
    await unlink(probePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Persisted ${label} directory is not writable at "${directory}": ${reason}`);
  }
}

export async function assertDurabilityExecutionReadiness(
  options: {
    requireWriteAudit?: boolean;
  } = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<DurableExecutionMode> {
  assertDeploymentReadiness(env);
  await assertWritablePersistenceDirectory(getJobDirectory(), "job-state");

  if (options.requireWriteAudit) {
    await assertWritablePersistenceDirectory(getWriteAuditDirectory(), "write-audit");
  }

  return getDurableExecutionMode(env);
}

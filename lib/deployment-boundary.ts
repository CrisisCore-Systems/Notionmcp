import {
  getPersistedStateEncryptionRequirementError,
  isRemotePrivateMode,
} from "@/lib/persisted-state";

export type DeploymentMode = "localhost-operator" | "remote-private-host";

const DURABLE_JOBS_WARNING_TITLE = "Durable jobs require a long-lived Node host.";
const DURABLE_JOBS_WARNING_MESSAGE =
  "Detached job workers and resumable state assume this app stays on a long-lived Node process with persistent local storage. Do not treat the default durable-jobs mode like a stateless hobby deploy.";

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

  return isRemotePrivateMode(env) ? "remote-private-host" : "localhost-operator";
}

export function areDurableJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOTIONMCP_RUN_JOBS_INLINE?.trim().toLowerCase() !== "true";
}

export function getDurableJobsWarning(
  env: NodeJS.ProcessEnv = process.env
): { title: string; message: string } | null {
  if (!areDurableJobsEnabled(env)) {
    return null;
  }

  return {
    title: DURABLE_JOBS_WARNING_TITLE,
    message: DURABLE_JOBS_WARNING_MESSAGE,
  };
}

export function getDeploymentReadinessError(env: NodeJS.ProcessEnv = process.env): string | null {
  const deploymentMode = getDeploymentMode(env);

  if (deploymentMode === "remote-private-host") {
    if (!hasConfiguredValue(env.APP_ALLOWED_ORIGIN) || !hasConfiguredValue(env.APP_ACCESS_TOKEN)) {
      return "Remote private host mode requires both APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN before the app will boot.";
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

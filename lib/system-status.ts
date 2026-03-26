import {
  assertDurabilityExecutionReadiness,
  getDeploymentReadinessError,
  getDeploymentMode,
  getDurableExecutionMode,
  getDurableJobsWarning,
} from "@/lib/deployment-boundary";
import {
  isJobWorkerStale,
  listJobRecords,
  type JobKind,
  type JobStatus,
} from "@/lib/job-store";
import { getCurrentNotionProviderState } from "@/lib/notion";
import { getOperatorMetricsSnapshot, getStartupDiagnosticsSnapshot } from "@/lib/observability";
import { getRequestRateLimitCoordinationSnapshot } from "@/lib/request-security";
import { listWriteAuditRecords } from "@/lib/write-audit-store";

type CountMap<T extends string> = Record<T, number>;

function createCountMap<T extends string>(keys: readonly T[]): CountMap<T> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as CountMap<T>;
}

function countBy<T extends string>(values: T[], keys: readonly T[]): CountMap<T> {
  const counts = createCountMap(keys);

  for (const value of values) {
    counts[value] += 1;
  }

  return counts;
}

const JOB_KINDS = ["research", "write"] as const satisfies readonly JobKind[];
const JOB_STATUSES = ["queued", "running", "complete", "error"] as const satisfies readonly JobStatus[];
const WRITE_AUDIT_STATUSES = ["running", "complete", "error"] as const;

export type SystemStatusSnapshot = {
  ready: boolean;
  checkedAt: string;
  deployment: {
    mode: ReturnType<typeof getDeploymentMode>;
    durableExecutionMode: ReturnType<typeof getDurableExecutionMode>;
    readinessError: string | null;
    warning: ReturnType<typeof getDurableJobsWarning>;
  };
  providerArchitecture: ReturnType<typeof getCurrentNotionProviderState>;
  diagnostics: ReturnType<typeof getStartupDiagnosticsSnapshot> & {
    deploymentMode: ReturnType<typeof getDeploymentMode>;
    durableExecutionMode: ReturnType<typeof getDurableExecutionMode>;
    providerMode: ReturnType<typeof getCurrentNotionProviderState>["mode"];
    persistenceReady: boolean;
    requestRateLimitCoordination: ReturnType<typeof getRequestRateLimitCoordinationSnapshot>;
    readinessError: string | null;
    warning: ReturnType<typeof getDurableJobsWarning>;
  };
  metrics: ReturnType<typeof getOperatorMetricsSnapshot>;
  runtime: {
    jobs: {
      total: number;
      byKind: CountMap<JobKind>;
      byStatus: CountMap<JobStatus>;
      activeWorkers: number;
      staleWorkers: number;
    };
    writeAudits: {
      total: number;
      byStatus: CountMap<(typeof WRITE_AUDIT_STATUSES)[number]>;
    };
  };
};

export async function getSystemStatusSnapshot(
  env: NodeJS.ProcessEnv = process.env
): Promise<SystemStatusSnapshot> {
  const deploymentReadinessError = getDeploymentReadinessError(env);
  let persistenceReady = false;

  if (!deploymentReadinessError) {
    await assertDurabilityExecutionReadiness({ requireWriteAudit: true }, env);
    persistenceReady = true;
  }

  const [jobRecords, writeAuditRecords] = await Promise.all([listJobRecords(), listWriteAuditRecords()]);
  const providerArchitecture = getCurrentNotionProviderState(env);

  return {
    ready: deploymentReadinessError === null,
    checkedAt: new Date().toISOString(),
    deployment: {
      mode: getDeploymentMode(env),
      durableExecutionMode: getDurableExecutionMode(env),
      readinessError: deploymentReadinessError,
      warning: getDurableJobsWarning(env),
    },
    providerArchitecture,
    diagnostics: {
      ...getStartupDiagnosticsSnapshot(),
      deploymentMode: getDeploymentMode(env),
      durableExecutionMode: getDurableExecutionMode(env),
      providerMode: providerArchitecture.mode,
      persistenceReady,
      requestRateLimitCoordination: getRequestRateLimitCoordinationSnapshot(env),
      readinessError: deploymentReadinessError,
      warning: getDurableJobsWarning(env),
    },
    metrics: getOperatorMetricsSnapshot(),
    runtime: {
      jobs: {
        total: jobRecords.length,
        byKind: countBy(
          jobRecords.map((record) => record.kind),
          JOB_KINDS
        ),
        byStatus: countBy(
          jobRecords.map((record) => record.status),
          JOB_STATUSES
        ),
        activeWorkers: jobRecords.filter((record) => record.status === "running" && !isJobWorkerStale(record)).length,
        staleWorkers: jobRecords.filter((record) => record.status === "running" && isJobWorkerStale(record)).length,
      },
      writeAudits: {
        total: writeAuditRecords.length,
        byStatus: countBy(
          writeAuditRecords.map((record) => record.status),
          WRITE_AUDIT_STATUSES
        ),
      },
    },
  };
}

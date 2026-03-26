import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

export type ObservabilityLogLevel = "debug" | "info" | "warn" | "error";
export type OperatorSurfaceKind = "health" | "ready" | "status";
export type OperatorMetricName =
  | "jobsCreated"
  | "jobsResumed"
  | "jobFailures"
  | "writeReconciliations"
  | "rateLimitRejects"
  | "rejectedUrls"
  | "queueClaimContention"
  | "queueClaimStaleLockRecovered"
  | "queueClaimFreshnessMiss"
  | "backgroundCleanupRuns"
  | "backgroundCleanupFilesDeleted";

export type ObservabilityContext = {
  requestId?: string;
  jobId?: string;
  method?: string;
  pathname?: string;
  host?: string;
  origin?: string;
  forwardedFor?: string;
} & Record<string, unknown>;

type OperatorMetricsCounters = Record<OperatorMetricName, number> & {
  operatorSurfaceChecks: Record<OperatorSurfaceKind, number>;
};

export type OperatorMetricsSnapshot = {
  startedAt: string;
  updatedAt: string;
  counters: OperatorMetricsCounters;
};

export type StartupDiagnosticsSnapshot = {
  processStartedAt: string;
  uptimeMs: number;
  process: {
    pid: number;
    nodeVersion: string;
    platform: NodeJS.Platform;
  };
  probes: {
    firstHealthCheckAt: string | null;
    lastHealthCheckAt: string | null;
    firstReadyCheckAt: string | null;
    lastReadyCheckAt: string | null;
    firstSuccessfulReadyAt: string | null;
    firstStatusCheckAt: string | null;
    lastStatusCheckAt: string | null;
  };
};

const OPERATOR_METRIC_NAMES = [
  "jobsCreated",
  "jobsResumed",
  "jobFailures",
  "writeReconciliations",
  "rateLimitRejects",
  "rejectedUrls",
  "queueClaimContention",
  "queueClaimStaleLockRecovered",
  "queueClaimFreshnessMiss",
  "backgroundCleanupRuns",
  "backgroundCleanupFilesDeleted",
] as const satisfies readonly OperatorMetricName[];
const OPERATOR_SURFACE_NAMES = ["health", "ready", "status"] as const satisfies readonly OperatorSurfaceKind[];

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyCounters(): OperatorMetricsCounters {
  return {
    jobsCreated: 0,
    jobsResumed: 0,
    jobFailures: 0,
    writeReconciliations: 0,
    rateLimitRejects: 0,
    rejectedUrls: 0,
    queueClaimContention: 0,
    queueClaimStaleLockRecovered: 0,
    queueClaimFreshnessMiss: 0,
    backgroundCleanupRuns: 0,
    backgroundCleanupFilesDeleted: 0,
    operatorSurfaceChecks: {
      health: 0,
      ready: 0,
      status: 0,
    },
  };
}

let processStartedAt = nowIso();
let metricsStartedAt = processStartedAt;
let metricsUpdatedAt = processStartedAt;
let metricsCounters = createEmptyCounters();
let probeTimestamps: StartupDiagnosticsSnapshot["probes"] = {
  firstHealthCheckAt: null,
  lastHealthCheckAt: null,
  firstReadyCheckAt: null,
  lastReadyCheckAt: null,
  firstSuccessfulReadyAt: null,
  firstStatusCheckAt: null,
  lastStatusCheckAt: null,
};

function getOperatorMetricsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.OPERATOR_METRICS_PATH?.trim();

  if (configured) {
    return configured;
  }

  if (env.NODE_ENV === "test") {
    return null;
  }

  return path.join(process.cwd(), ".notionmcp-data", "operator-metrics.json");
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizePersistedCounters(value: unknown): OperatorMetricsCounters | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const nextCounters = createEmptyCounters();

  for (const metric of OPERATOR_METRIC_NAMES) {
    const persistedValue = candidate[metric];

    if (typeof persistedValue !== "number" || !Number.isFinite(persistedValue) || persistedValue < 0) {
      return null;
    }

    nextCounters[metric] = persistedValue;
  }

  const surfaceChecks = candidate.operatorSurfaceChecks;

  if (!surfaceChecks || typeof surfaceChecks !== "object" || Array.isArray(surfaceChecks)) {
    return null;
  }

  const surfaceCandidate = surfaceChecks as Record<string, unknown>;

  for (const surface of OPERATOR_SURFACE_NAMES) {
    const persistedValue = surfaceCandidate[surface];

    if (typeof persistedValue !== "number" || !Number.isFinite(persistedValue) || persistedValue < 0) {
      return null;
    }

    nextCounters.operatorSurfaceChecks[surface] = persistedValue;
  }

  return nextCounters;
}

function restorePersistedMetrics(env: NodeJS.ProcessEnv = process.env): void {
  const metricsPath = getOperatorMetricsPath(env);

  if (!metricsPath) {
    return;
  }

  try {
    const raw = readFileSync(metricsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const candidate = parsed as Partial<OperatorMetricsSnapshot>;
    const normalizedCounters = normalizePersistedCounters(candidate.counters);

    if (!normalizedCounters) {
      return;
    }

    metricsStartedAt = isIsoTimestamp(candidate.startedAt) ? candidate.startedAt : metricsStartedAt;
    metricsUpdatedAt = isIsoTimestamp(candidate.updatedAt) ? candidate.updatedAt : metricsStartedAt;
    metricsCounters = normalizedCounters;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Failed to restore persisted operator metrics.", error);
    }
  }
}

function persistOperatorMetrics(env: NodeJS.ProcessEnv = process.env): void {
  const metricsPath = getOperatorMetricsPath(env);

  if (!metricsPath) {
    return;
  }

  try {
    mkdirSync(path.dirname(metricsPath), { recursive: true });
    writeFileSync(metricsPath, `${JSON.stringify(getOperatorMetricsSnapshot(), null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("Failed to persist operator metrics.", error);
  }
}

restorePersistedMetrics();

function touchMetricsUpdatedAt(): void {
  metricsUpdatedAt = nowIso();
}

function getConsoleMethod(level: ObservabilityLogLevel): (...data: unknown[]) => void {
  switch (level) {
    case "debug":
      return console.debug;
    case "warn":
      return console.warn;
    case "error":
      return console.error;
    default:
      return console.info;
  }
}

export function getRequestId(req: NextRequest): string {
  const supplied =
    req.headers.get("x-request-id")?.trim() || req.headers.get("x-correlation-id")?.trim() || "";
  return supplied || randomUUID();
}

export function buildRequestLogContext(
  req: NextRequest,
  requestId: string,
  extras: ObservabilityContext = {}
): ObservabilityContext {
  return {
    requestId,
    method: req.method,
    pathname: req.nextUrl.pathname,
    host: req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "unknown",
    ...extras,
  };
}

export function incrementMetric(metric: OperatorMetricName, amount = 1): void {
  if (amount <= 0) {
    return;
  }

  metricsCounters[metric] += amount;
  touchMetricsUpdatedAt();
  persistOperatorMetrics();
}

export function recordOperatorSurfaceCheck(
  surface: OperatorSurfaceKind,
  options: { ready?: boolean } = {}
): void {
  const timestamp = nowIso();
  metricsCounters.operatorSurfaceChecks[surface] += 1;
  metricsUpdatedAt = timestamp;

  if (surface === "health") {
    probeTimestamps.firstHealthCheckAt ??= timestamp;
    probeTimestamps.lastHealthCheckAt = timestamp;
    persistOperatorMetrics();
    return;
  }

  if (surface === "ready") {
    probeTimestamps.firstReadyCheckAt ??= timestamp;
    probeTimestamps.lastReadyCheckAt = timestamp;

    if (options.ready) {
      probeTimestamps.firstSuccessfulReadyAt ??= timestamp;
    }

    persistOperatorMetrics();
    return;
  }

  probeTimestamps.firstStatusCheckAt ??= timestamp;
  probeTimestamps.lastStatusCheckAt = timestamp;
  persistOperatorMetrics();
}

export function getOperatorMetricsSnapshot(): OperatorMetricsSnapshot {
  return {
    startedAt: metricsStartedAt,
    updatedAt: metricsUpdatedAt,
    counters: {
      ...metricsCounters,
      operatorSurfaceChecks: {
        ...metricsCounters.operatorSurfaceChecks,
      },
    },
  };
}

export function getStartupDiagnosticsSnapshot(): StartupDiagnosticsSnapshot {
  return {
    processStartedAt,
    uptimeMs: Math.max(0, Date.now() - new Date(processStartedAt).getTime()),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
    },
    probes: {
      ...probeTimestamps,
    },
  };
}

export function logStructured(
  scope: string,
  level: ObservabilityLogLevel,
  message: string,
  context: ObservabilityContext = {}
): void {
  getConsoleMethod(level)(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      context,
    })
  );
}

export function infoLog(scope: string, message: string, context: ObservabilityContext = {}): void {
  logStructured(scope, "info", message, context);
}

export function warnLog(scope: string, message: string, context: ObservabilityContext = {}): void {
  logStructured(scope, "warn", message, context);
}

export function errorLog(scope: string, message: string, context: ObservabilityContext = {}): void {
  logStructured(scope, "error", message, context);
}

export const observabilityTestOverrides = {
  reset(options: { clearPersistedMetrics?: boolean } = {}): void {
    processStartedAt = nowIso();
    metricsStartedAt = processStartedAt;
    metricsUpdatedAt = processStartedAt;
    metricsCounters = createEmptyCounters();
    probeTimestamps = {
      firstHealthCheckAt: null,
      lastHealthCheckAt: null,
      firstReadyCheckAt: null,
      lastReadyCheckAt: null,
      firstSuccessfulReadyAt: null,
      firstStatusCheckAt: null,
      lastStatusCheckAt: null,
    };

    if (options.clearPersistedMetrics) {
      const metricsPath = getOperatorMetricsPath();

      if (metricsPath) {
        rmSync(metricsPath, { force: true });
      }
    }
  },
  reloadPersistedMetrics(): void {
    processStartedAt = nowIso();
    metricsStartedAt = processStartedAt;
    metricsUpdatedAt = processStartedAt;
    metricsCounters = createEmptyCounters();
    probeTimestamps = {
      firstHealthCheckAt: null,
      lastHealthCheckAt: null,
      firstReadyCheckAt: null,
      lastReadyCheckAt: null,
      firstSuccessfulReadyAt: null,
      firstStatusCheckAt: null,
      lastStatusCheckAt: null,
    };
    restorePersistedMetrics();
  },
};

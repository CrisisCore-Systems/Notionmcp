import { randomUUID } from "node:crypto";
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
    return;
  }

  if (surface === "ready") {
    probeTimestamps.firstReadyCheckAt ??= timestamp;
    probeTimestamps.lastReadyCheckAt = timestamp;

    if (options.ready) {
      probeTimestamps.firstSuccessfulReadyAt ??= timestamp;
    }

    return;
  }

  probeTimestamps.firstStatusCheckAt ??= timestamp;
  probeTimestamps.lastStatusCheckAt = timestamp;
}

export function getOperatorMetricsSnapshot(): OperatorMetricsSnapshot {
  return {
    startedAt: processStartedAt,
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
  reset(): void {
    processStartedAt = nowIso();
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
  },
};

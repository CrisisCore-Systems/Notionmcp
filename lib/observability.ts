import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

export type ObservabilityLogLevel = "debug" | "info" | "warn" | "error";

export type ObservabilityContext = {
  requestId?: string;
  jobId?: string;
  method?: string;
  pathname?: string;
  host?: string;
  origin?: string;
  forwardedFor?: string;
} & Record<string, unknown>;

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

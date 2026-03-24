import { createHash } from "node:crypto";
import path from "node:path";
import type { NextRequest } from "next/server";
import { getDeploymentMode } from "@/lib/deployment-boundary";
import { readPersistedStateFile, writePersistedStateFile } from "@/lib/persisted-state";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const remoteRequestRateLimit = new Map<string, RateLimitEntry>();
const REMOTE_RATE_LIMIT_RETENTION_ENV_VAR = "REMOTE_RATE_LIMIT_RETENTION_DAYS";

export const requestSecurityTestOverrides = {
  clearRateLimitState() {
    remoteRequestRateLimit.clear();
  },
};

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getExpectedOrigin(req: NextRequest): string | null {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");

  if (!host) {
    return null;
  }

  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol =
    forwardedProto || req.nextUrl.protocol.replace(/:$/, "") || "https";

  return `${protocol}://${host}`;
}

function getRequestOrigin(req: NextRequest): string | null {
  return (
    normalizeOrigin(req.headers.get("origin")) ??
    normalizeOrigin(req.headers.get("referer"))
  );
}

function getRequestHostname(req: NextRequest): string {
  const expectedOrigin = getExpectedOrigin(req);

  if (!expectedOrigin) {
    return "";
  }

  try {
    return new URL(expectedOrigin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "127.0.0.1"
  );
}

function getSuppliedAccessToken(req: NextRequest): string {
  const explicitToken = req.headers.get("x-app-access-token")?.trim();

  if (explicitToken) {
    return explicitToken;
  }

  const authorization = req.headers.get("authorization")?.trim();

  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return authorization.slice(7).trim();
}

function getRemoteRateLimitKey(req: NextRequest, requestOrigin: string | null): string {
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return [requestOrigin ?? "unknown-origin", forwardedFor ?? "unknown-ip"].join("|");
}

function getRateLimitWindowMs(): number {
  const configured = Number(process.env.APP_RATE_LIMIT_WINDOW_MS ?? "60000");
  return Number.isFinite(configured) && configured > 0 ? configured : 60000;
}

function getRateLimitMaxRequests(): number {
  const configured = Number(process.env.APP_RATE_LIMIT_MAX ?? "60");
  return Number.isFinite(configured) && configured > 0 ? configured : 60;
}

function shouldPersistRemoteRateLimitState(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDeploymentMode(env) === "remote-private-host";
}

function getRemoteRateLimitDirectory(): string {
  const configured = process.env.REMOTE_RATE_LIMIT_DIR?.trim();
  return configured || path.join(process.cwd(), ".notionmcp-data", "request-rate-limits");
}

function getRemoteRateLimitPath(key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return path.join(getRemoteRateLimitDirectory(), `${digest}.json`);
}

async function loadPersistedRemoteRateLimitEntry(key: string): Promise<RateLimitEntry | null> {
  try {
    return await readPersistedStateFile<RateLimitEntry>(
      getRemoteRateLimitPath(key),
      REMOTE_RATE_LIMIT_RETENTION_ENV_VAR
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function savePersistedRemoteRateLimitEntry(key: string, entry: RateLimitEntry): Promise<void> {
  await writePersistedStateFile(
    getRemoteRateLimitPath(key),
    entry,
    REMOTE_RATE_LIMIT_RETENTION_ENV_VAR
  );
}

async function isRemoteRequestRateLimited(req: NextRequest, requestOrigin: string | null): Promise<boolean> {
  const key = getRemoteRateLimitKey(req, requestOrigin);
  const now = Date.now();
  const current = shouldPersistRemoteRateLimitState()
    ? await loadPersistedRemoteRateLimitEntry(key)
    : remoteRequestRateLimit.get(key);

  if (!current || current.resetAt <= now) {
    const nextEntry = {
      count: 1,
      resetAt: now + getRateLimitWindowMs(),
    };
    remoteRequestRateLimit.set(key, nextEntry);

    if (shouldPersistRemoteRateLimitState()) {
      await savePersistedRemoteRateLimitEntry(key, nextEntry);
    }

    return false;
  }

  const nextEntry = {
    count: current.count + 1,
    resetAt: current.resetAt,
  };
  remoteRequestRateLimit.set(key, nextEntry);

  if (shouldPersistRemoteRateLimitState()) {
    await savePersistedRemoteRateLimitEntry(key, nextEntry);
  }

  return nextEntry.count > getRateLimitMaxRequests();
}

function logFailedAccessAttempt(req: NextRequest, message: string) {
  const requestOrigin = getRequestOrigin(req) ?? "unknown";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "unknown";
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  console.warn(`[request-security] ${message}`, {
    origin: requestOrigin,
    host,
    forwardedFor,
    pathname: req.nextUrl.pathname,
  });
}

function reject(req: NextRequest, message: string, status: number): Response {
  logFailedAccessAttempt(req, message);
  return jsonError(message, status);
}

export async function validateApiRequest(req: NextRequest): Promise<Response | null> {
  const requestOrigin = getRequestOrigin(req);
  const expectedOrigin = getExpectedOrigin(req);
  const hostname = getRequestHostname(req);

  if (requestOrigin && expectedOrigin && requestOrigin !== expectedOrigin) {
    return reject(req, "Cross-origin API requests are not allowed.", 403);
  }

  if (isLocalHostname(hostname)) {
    return null;
  }

  const allowedOrigin = normalizeOrigin(process.env.APP_ALLOWED_ORIGIN?.trim() ?? null);
  const requiredToken = process.env.APP_ACCESS_TOKEN?.trim() ?? "";

  if (!allowedOrigin || !requiredToken) {
    return reject(
      req,
      "Remote API access is disabled. Run the app locally, or configure APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN for a tightly controlled private deployment.",
      403
    );
  }

  if (requestOrigin !== allowedOrigin) {
    return reject(req, "API requests must originate from the configured APP_ALLOWED_ORIGIN.", 403);
  }

  if (getSuppliedAccessToken(req) !== requiredToken) {
    return reject(req, "A valid API access token is required.", 401);
  }

  try {
    if (await isRemoteRequestRateLimited(req, requestOrigin)) {
      return reject(req, "Remote API rate limit exceeded. Please slow down and retry shortly.", 429);
    }
  } catch (error) {
    return reject(
      req,
      `Remote API request coordination is unavailable on this host: ${
        error instanceof Error ? error.message : String(error)
      }`,
      503
    );
  }

  return null;
}

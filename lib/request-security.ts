import type { NextRequest } from "next/server";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const remoteRequestRateLimit = new Map<string, RateLimitEntry>();

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

function isRemoteRequestRateLimited(req: NextRequest, requestOrigin: string | null): boolean {
  const key = getRemoteRateLimitKey(req, requestOrigin);
  const now = Date.now();
  const current = remoteRequestRateLimit.get(key);

  if (!current || current.resetAt <= now) {
    remoteRequestRateLimit.set(key, {
      count: 1,
      resetAt: now + getRateLimitWindowMs(),
    });
    return false;
  }

  current.count += 1;
  return current.count > getRateLimitMaxRequests();
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

export function validateApiRequest(req: NextRequest): Response | null {
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

  if (isRemoteRequestRateLimited(req, requestOrigin)) {
    return reject(req, "Remote API rate limit exceeded. Please slow down and retry shortly.", 429);
  }

  return null;
}

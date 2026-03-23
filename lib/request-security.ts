import type { NextRequest } from "next/server";

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

export function validateApiRequest(req: NextRequest): Response | null {
  const requestOrigin = getRequestOrigin(req);
  const expectedOrigin = getExpectedOrigin(req);
  const hostname = getRequestHostname(req);

  if (requestOrigin && expectedOrigin && requestOrigin !== expectedOrigin) {
    return jsonError("Cross-origin API requests are not allowed.", 403);
  }

  if (isLocalHostname(hostname)) {
    return null;
  }

  const allowedOrigin = normalizeOrigin(process.env.APP_ALLOWED_ORIGIN?.trim() ?? null);
  const requiredToken = process.env.APP_ACCESS_TOKEN?.trim() ?? "";

  if (!allowedOrigin || !requiredToken) {
    return jsonError(
      "Remote API access is disabled. Run the app locally, or configure APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN for a tightly controlled private deployment.",
      403
    );
  }

  if (requestOrigin !== allowedOrigin) {
    return jsonError("API requests must originate from the configured APP_ALLOWED_ORIGIN.", 403);
  }

  if (getSuppliedAccessToken(req) !== requiredToken) {
    return jsonError("A valid API access token is required.", 401);
  }

  return null;
}

import { NextRequest, NextResponse } from "next/server";
import {
  clearActiveNotionConnectionCookies,
  exchangeNotionOAuthCode,
  NOTION_OAUTH_STATE_COOKIE_NAME,
  persistNotionConnection,
  setActiveNotionConnectionCookies,
} from "@/lib/notion-oauth";

export const runtime = "nodejs";
export const maxDuration = 120;

function buildRedirectUrl(req: NextRequest, params: Record<string, string>): URL {
  const url = new URL("/", req.url);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  url.hash = "operator-console";
  return url;
}

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state")?.trim() ?? "";
  const code = req.nextUrl.searchParams.get("code")?.trim() ?? "";
  const error = req.nextUrl.searchParams.get("error")?.trim() ?? "";
  const expectedState = req.cookies.get(NOTION_OAUTH_STATE_COOKIE_NAME)?.value?.trim() ?? "";

  if (error) {
    const response = NextResponse.redirect(
      buildRedirectUrl(req, { notion_oauth_error: error })
    );
    clearActiveNotionConnectionCookies(response);
    response.cookies.delete(NOTION_OAUTH_STATE_COOKIE_NAME);
    return response;
  }

  if (!state || !expectedState || state !== expectedState) {
    const response = NextResponse.redirect(
      buildRedirectUrl(req, { notion_oauth_error: "state_mismatch" })
    );
    clearActiveNotionConnectionCookies(response);
    response.cookies.delete(NOTION_OAUTH_STATE_COOKIE_NAME);
    return response;
  }

  if (!code) {
    const response = NextResponse.redirect(
      buildRedirectUrl(req, { notion_oauth_error: "missing_code" })
    );
    clearActiveNotionConnectionCookies(response);
    response.cookies.delete(NOTION_OAUTH_STATE_COOKIE_NAME);
    return response;
  }

  try {
    const connection = await exchangeNotionOAuthCode(code);
    await persistNotionConnection(connection);

    const response = NextResponse.redirect(
      buildRedirectUrl(req, { notion_connected: connection.workspaceName })
    );
    response.cookies.delete(NOTION_OAUTH_STATE_COOKIE_NAME);
    setActiveNotionConnectionCookies(response, connection, req.nextUrl.protocol === "https:");
    return response;
  } catch (callbackError) {
    const response = NextResponse.redirect(
      buildRedirectUrl(req, {
        notion_oauth_error:
          callbackError instanceof Error ? callbackError.message : String(callbackError),
      })
    );
    clearActiveNotionConnectionCookies(response);
    response.cookies.delete(NOTION_OAUTH_STATE_COOKIE_NAME);
    return response;
  }
}
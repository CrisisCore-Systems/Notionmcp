import { NextRequest, NextResponse } from "next/server";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  exchangeNotionOAuthCode,
  NOTION_OAUTH_STATE_COOKIE_NAME,
  persistNotionConnection,
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
    response.cookies.delete(NOTION_OAUTH_STATE_COOKIE_NAME);
    return response;
  }

  if (!state || !expectedState || state !== expectedState) {
    const response = NextResponse.redirect(
      buildRedirectUrl(req, { notion_oauth_error: "state_mismatch" })
    );
    response.cookies.delete(NOTION_OAUTH_STATE_COOKIE_NAME);
    return response;
  }

  if (!code) {
    const response = NextResponse.redirect(
      buildRedirectUrl(req, { notion_oauth_error: "missing_code" })
    );
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
    response.cookies.set({
      name: ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
      value: connection.connectionId,
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (callbackError) {
    const response = NextResponse.redirect(
      buildRedirectUrl(req, {
        notion_oauth_error:
          callbackError instanceof Error ? callbackError.message : String(callbackError),
      })
    );
    response.cookies.delete(NOTION_OAUTH_STATE_COOKIE_NAME);
    return response;
  }
}
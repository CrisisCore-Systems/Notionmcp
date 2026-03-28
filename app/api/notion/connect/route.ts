import { NextRequest, NextResponse } from "next/server";
import {
  buildNotionOAuthAuthorizationUrl,
  createNotionOAuthState,
  getNotionOAuthConfigurationError,
  NOTION_OAUTH_STATE_COOKIE_NAME,
} from "@/lib/notion-oauth";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const configError = getNotionOAuthConfigurationError();

  if (configError) {
    return Response.json({ error: configError }, { status: 503 });
  }

  const state = createNotionOAuthState();
  const response = NextResponse.redirect(buildNotionOAuthAuthorizationUrl(state));
  response.cookies.set({
    name: NOTION_OAUTH_STATE_COOKIE_NAME,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 10 * 60,
  });
  return response;
}
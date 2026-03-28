import { NextRequest, NextResponse } from "next/server";
import { ACTIVE_NOTION_CONNECTION_COOKIE_NAME } from "@/lib/notion-oauth";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const response = NextResponse.redirect(new URL("/#operator-console", req.url));
  response.cookies.delete(ACTIVE_NOTION_CONNECTION_COOKIE_NAME);
  return response;
}
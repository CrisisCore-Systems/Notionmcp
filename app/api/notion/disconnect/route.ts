import { NextRequest, NextResponse } from "next/server";
import { clearActiveNotionConnectionCookies } from "@/lib/notion-oauth";
import { ACTIVE_NOTION_QUEUE_BINDING_COOKIE_NAME } from "@/lib/notion-queue-binding";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const response = NextResponse.redirect(new URL("/#operator-console", req.url));
  clearActiveNotionConnectionCookies(response);
  response.cookies.delete(ACTIVE_NOTION_QUEUE_BINDING_COOKIE_NAME);
  return response;
}
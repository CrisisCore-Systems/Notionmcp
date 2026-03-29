import { NextRequest } from "next/server";
import { buildApiSurfaceHeaders, getNotionConnectionRouteContract } from "@/lib/api-surface";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  getActiveNotionConnectionFromRequest,
  getNotionConnectionStatus,
} from "@/lib/notion-oauth";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const activeConnectionId = req.cookies.get(ACTIVE_NOTION_CONNECTION_COOKIE_NAME)?.value?.trim() ?? null;
  const activeConnection = getActiveNotionConnectionFromRequest(req);
  const connectionStatus = await getNotionConnectionStatus(activeConnectionId, activeConnection);

  return Response.json(
    {
      ...connectionStatus,
      connectionContract: getNotionConnectionRouteContract(),
    },
    {
      headers: buildApiSurfaceHeaders("notion-connection"),
    }
  );
}
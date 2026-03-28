import { NextRequest } from "next/server";
import {
  buildApiSurfaceHeaders,
  getNotionParentDiscoveryRouteContract,
} from "@/lib/api-surface";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  getNotionConnectionStatus,
  listAccessibleNotionParentPages,
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
  const connectionStatus = await getNotionConnectionStatus(activeConnectionId);

  if (!activeConnectionId || !connectionStatus.activeConnection) {
    return Response.json(
      {
        error: "Connect a Notion workspace first before discovering parent pages.",
        ...connectionStatus,
        discoveryContract: getNotionParentDiscoveryRouteContract(),
      },
      {
        status: 409,
        headers: buildApiSurfaceHeaders("notion-discovery"),
      }
    );
  }

  const parents = await listAccessibleNotionParentPages(activeConnectionId);

  return Response.json(
    {
      ...connectionStatus,
      parents,
      discoveryContract: getNotionParentDiscoveryRouteContract(),
    },
    {
      headers: buildApiSurfaceHeaders("notion-discovery"),
    }
  );
}
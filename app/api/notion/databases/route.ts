import { NextRequest } from "next/server";
import {
  buildApiSurfaceHeaders,
  getNotionDatabaseDiscoveryRouteContract,
} from "@/lib/api-surface";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  getActiveNotionConnectionFromRequest,
  getNotionConnectionStatus,
  listAccessibleNotionDatabases,
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

  if (!activeConnectionId || !connectionStatus.activeConnection) {
    return Response.json(
      {
        error: "Connect a Notion workspace first before discovering databases.",
        ...connectionStatus,
        discoveryContract: getNotionDatabaseDiscoveryRouteContract(),
      },
      {
        status: 409,
        headers: buildApiSurfaceHeaders("notion-discovery"),
      }
    );
  }

  const databases = await listAccessibleNotionDatabases(activeConnectionId);

  return Response.json(
    {
      ...connectionStatus,
      databases,
      discoveryContract: getNotionDatabaseDiscoveryRouteContract(),
    },
    {
      headers: buildApiSurfaceHeaders("notion-discovery"),
    }
  );
}
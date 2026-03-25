import { NextRequest } from "next/server";
import { buildApiSurfaceHeaders, getStatusRouteContract } from "@/lib/api-surface";
import { getSystemStatusSnapshot } from "@/lib/system-status";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const snapshot = await getSystemStatusSnapshot();

  return Response.json(
    {
      ...snapshot,
      statusContract: getStatusRouteContract(),
    },
    {
      status: snapshot.ready ? 200 : 503,
      headers: buildApiSurfaceHeaders("system-status"),
    }
  );
}

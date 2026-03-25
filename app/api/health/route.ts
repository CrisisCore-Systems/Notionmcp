import { NextRequest } from "next/server";
import { buildApiSurfaceHeaders, getHealthRouteContract } from "@/lib/api-surface";
import { buildRequestLogContext, getRequestId, infoLog } from "@/lib/observability";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const requestId = getRequestId(req);
  infoLog("health-check", "Health probe responded alive.", buildRequestLogContext(req, requestId));

  return Response.json(
    {
      alive: true,
      checkedAt: new Date().toISOString(),
      healthContract: getHealthRouteContract(),
    },
    {
      headers: {
        ...buildApiSurfaceHeaders("health-check"),
        "x-request-id": requestId,
      },
    }
  );
}

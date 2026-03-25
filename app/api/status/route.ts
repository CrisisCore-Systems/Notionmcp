import { NextRequest } from "next/server";
import { buildApiSurfaceHeaders, getStatusRouteContract } from "@/lib/api-surface";
import { buildRequestLogContext, getRequestId, infoLog, recordOperatorSurfaceCheck } from "@/lib/observability";
import { getSystemStatusSnapshot } from "@/lib/system-status";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const requestId = getRequestId(req);
  recordOperatorSurfaceCheck("status");
  const snapshot = await getSystemStatusSnapshot();
  infoLog(
    "system-status",
    "Status probe completed.",
    buildRequestLogContext(req, requestId, {
      ready: snapshot.ready,
      jobsTotal: snapshot.runtime.jobs.total,
      writeAuditsTotal: snapshot.runtime.writeAudits.total,
    })
  );

  return Response.json(
    {
      ...snapshot,
      statusContract: getStatusRouteContract(),
    },
    {
      status: snapshot.ready ? 200 : 503,
      headers: {
        ...buildApiSurfaceHeaders("system-status"),
        "x-request-id": requestId,
      },
    }
  );
}

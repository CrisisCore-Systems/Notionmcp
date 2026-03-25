import { NextRequest } from "next/server";
import {
  buildApiSurfaceHeaders,
  getReadinessRouteContract,
} from "@/lib/api-surface";
import {
  assertDurabilityExecutionReadiness,
  getDeploymentMode,
  getDurableExecutionMode,
  getDurableJobsWarning,
} from "@/lib/deployment-boundary";
import { buildRequestLogContext, getRequestId, infoLog, warnLog } from "@/lib/observability";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const requestId = getRequestId(req);
  let ready = true;
  let error: string | null = null;

  try {
    await assertDurabilityExecutionReadiness({ requireWriteAudit: true });
  } catch (readinessError) {
    ready = false;
    error = readinessError instanceof Error ? readinessError.message : String(readinessError);
  }

  const logContext = buildRequestLogContext(req, requestId, {
    deploymentMode: getDeploymentMode(),
    durableExecutionMode: getDurableExecutionMode(),
    ready,
    ...(error ? { error } : {}),
  });

  if (ready) {
    infoLog("readiness-check", "Readiness probe succeeded.", logContext);
  } else {
    warnLog("readiness-check", "Readiness probe failed.", logContext);
  }

  return Response.json(
    {
      ready,
      checkedAt: new Date().toISOString(),
      error,
      warning: getDurableJobsWarning(),
      readinessContract: getReadinessRouteContract(),
    },
    {
      status: ready ? 200 : 503,
      headers: {
        ...buildApiSurfaceHeaders("readiness-check"),
        "x-request-id": requestId,
      },
    }
  );
}

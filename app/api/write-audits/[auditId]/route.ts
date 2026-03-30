import { NextRequest } from "next/server";
import { buildApiSurfaceHeaders, getWriteAuditVerificationContract } from "@/lib/api-surface";
import { createApiErrorResponse } from "@/lib/api-route-errors";
import { getDeploymentReadinessError } from "@/lib/deployment-boundary";
import { validateApiRequest } from "@/lib/request-security";
import { isValidWriteAuditId, loadWriteAuditRecord } from "@/lib/write-audit-store";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    auditId: string;
  }>;
};

export async function GET(req: NextRequest, context: RouteContext) {
  const deploymentReadinessError = getDeploymentReadinessError();

  if (deploymentReadinessError) {
    return createApiErrorResponse("write-audit-verification", 503, deploymentReadinessError);
  }

  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const { auditId } = await context.params;

  if (!isValidWriteAuditId(auditId)) {
    return new Response(JSON.stringify({ error: "Write audit not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const record = await loadWriteAuditRecord(auditId);

  if (!record) {
    return new Response(JSON.stringify({ error: "Write audit not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return Response.json(
    {
      ...record,
      verificationContract: getWriteAuditVerificationContract(),
    },
    {
      headers: buildApiSurfaceHeaders("write-audit-verification"),
    }
  );
}

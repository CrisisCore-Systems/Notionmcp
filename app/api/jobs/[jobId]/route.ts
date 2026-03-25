import { NextRequest } from "next/server";
import { buildApiSurfaceHeaders, getJobVerificationContract } from "@/lib/api-surface";
import { assertDeploymentReadiness } from "@/lib/deployment-boundary";
import { isValidJobId, loadJobRecord } from "@/lib/job-store";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function GET(req: NextRequest, context: RouteContext) {
  assertDeploymentReadiness();
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const { jobId } = await context.params;

  if (!isValidJobId(jobId)) {
    return new Response(JSON.stringify({ error: "Job state not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const record = await loadJobRecord(jobId);

  if (!record) {
    return new Response(JSON.stringify({ error: "Job state not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return Response.json(
    {
      ...record,
      verificationContract: getJobVerificationContract(),
    },
    {
      headers: buildApiSurfaceHeaders("durable-job-verification"),
    }
  );
}

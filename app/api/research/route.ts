import { NextRequest } from "next/server";
import { getResearchRouteContract, buildApiSurfaceHeaders } from "@/lib/api-surface";
import { parseResearchMode } from "@/lib/agent";
import { createJobEventStreamResponse } from "@/lib/job-sse";
import { createDurableJob, ensureJobWorker } from "@/lib/job-runner";
import { isValidJobId, loadJobRecord } from "@/lib/job-store";
import {
  assertDeploymentReadiness,
  assertDurabilityExecutionReadiness,
  warnIfDurableJobsNeedLongLivedHost,
} from "@/lib/deployment-boundary";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  assertDeploymentReadiness();
  const requestError = validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  return Response.json(getResearchRouteContract(), {
    headers: buildApiSurfaceHeaders("research-control"),
  });
}

export async function POST(req: NextRequest) {
  assertDeploymentReadiness();
  warnIfDurableJobsNeedLongLivedHost();
  const requestError = validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const body = (await req.json()) as Record<string, unknown>;
  const requestedJobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  const afterEventId =
    typeof body.afterEventId === "number" && Number.isInteger(body.afterEventId) && body.afterEventId >= 0
      ? body.afterEventId
      : 0;
  let jobId = requestedJobId;

  if (jobId) {
    if (!isValidJobId(jobId)) {
      return new Response(JSON.stringify({ error: "A valid research job ID is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const existingJob = await loadJobRecord(jobId);

    if (!existingJob || existingJob.kind !== "research") {
      return new Response(JSON.stringify({ error: "Research job was not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  } else {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const requestedResearchMode = typeof body.researchMode === "string" ? body.researchMode.trim() : undefined;
    const researchMode = parseResearchMode(requestedResearchMode);

    if (!prompt) {
      return new Response(JSON.stringify({ error: "Prompt is required" }), {
        status: 400,
      });
    }

    if (requestedResearchMode && !researchMode) {
      return new Response(
        JSON.stringify({
          error: 'Invalid researchMode. Supported values are: "fast", "deep".',
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    await assertDurabilityExecutionReadiness();
    const job = await createDurableJob("research", { prompt, researchMode });
    jobId = job.id;
  }

  await ensureJobWorker(jobId);
  return createJobEventStreamResponse(jobId, { afterEventId });
}

import { NextRequest } from "next/server";
import { buildApiSurfaceHeaders, getWriteRouteContract } from "@/lib/api-surface";
import { createJobEventStreamResponse } from "@/lib/job-sse";
import { createDurableJob, ensureJobWorker } from "@/lib/job-runner";
import { isValidJobId, loadJobRecord } from "@/lib/job-store";
import {
  assertDeploymentReadiness,
  assertDurabilityExecutionReadiness,
  warnIfDurableJobsNeedLongLivedHost,
} from "@/lib/deployment-boundary";
import { validateApiRequest } from "@/lib/request-security";
import { isValidDatabaseId, parseResearchResult } from "@/lib/write-payload";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  assertDeploymentReadiness();
  const requestError = validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  return Response.json(getWriteRouteContract(), {
    headers: buildApiSurfaceHeaders("write-control"),
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
      return new Response(JSON.stringify({ error: "A valid write job ID is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const existingJob = await loadJobRecord(jobId);

    if (!existingJob || existingJob.kind !== "write") {
      return new Response(JSON.stringify({ error: "Write job was not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }
  } else {
    const targetDatabaseId =
      typeof body.targetDatabaseId === "string" ? body.targetDatabaseId.trim() : "";
    const resumeFromIndex =
      typeof body.resumeFromIndex === "number" ? body.resumeFromIndex : 0;

    if (!Number.isInteger(resumeFromIndex) || resumeFromIndex < 0) {
      return new Response(JSON.stringify({ error: "resumeFromIndex must be a non-negative integer" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    if (resumeFromIndex > 0 && !targetDatabaseId) {
      return new Response(
        JSON.stringify({ error: "targetDatabaseId is required when resuming a partial write" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    if (targetDatabaseId && !isValidDatabaseId(targetDatabaseId)) {
      return new Response(JSON.stringify({ error: "A valid Notion database ID is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    let normalizedBody: ReturnType<typeof parseResearchResult>;

    try {
      normalizedBody = parseResearchResult(body);
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : "A complete research result is required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    if (resumeFromIndex > normalizedBody.items.length) {
      return new Response(
        JSON.stringify({ error: "resumeFromIndex cannot be greater than the number of items" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    await assertDurabilityExecutionReadiness({ requireWriteAudit: true });
    const job = await createDurableJob("write", {
      ...normalizedBody,
      ...(targetDatabaseId ? { targetDatabaseId } : {}),
      ...(resumeFromIndex > 0 ? { resumeFromIndex } : {}),
    });
    jobId = job.id;
  }

  await ensureJobWorker(jobId);
  return createJobEventStreamResponse(jobId, { afterEventId });
}

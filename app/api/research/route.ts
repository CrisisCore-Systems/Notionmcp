import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getResearchRouteContract, buildApiSurfaceHeaders } from "@/lib/api-surface";
import { parseResearchMode } from "@/lib/agent";
import { createJobEventStreamResponse } from "@/lib/job-sse";
import { createDurableJob, ensureJobWorker } from "@/lib/job-runner";
import { isValidJobId, loadJobRecord } from "@/lib/job-store";
import { ACTIVE_NOTION_CONNECTION_COOKIE_NAME } from "@/lib/notion-oauth";
import {
  getNotionQueueConfigValidationError,
  normalizeNotionQueueConfig,
} from "@/lib/notion-queue";
import { claimNextNotionQueueEntry, updateNotionQueueLifecycle } from "@/lib/notion-mcp";
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
  const requestError = await validateApiRequest(req);

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
  const requestError = await validateApiRequest(req);

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
    const activeConnectionId = req.cookies.get(ACTIVE_NOTION_CONNECTION_COOKIE_NAME)?.value?.trim() || "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const requestedResearchMode = typeof body.researchMode === "string" ? body.researchMode.trim() : undefined;
    const researchMode = parseResearchMode(requestedResearchMode);
    const rawNotionQueue = body.notionQueue;
    const notionQueue =
      rawNotionQueue === undefined ? null : normalizeNotionQueueConfig(rawNotionQueue);

    if (rawNotionQueue !== undefined && !notionQueue) {
      return new Response(
        JSON.stringify({ error: "A notionQueue object with a Notion database ID is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    if (notionQueue) {
      const queueValidationError = getNotionQueueConfigValidationError(notionQueue);

      if (queueValidationError) {
        return new Response(JSON.stringify({ error: queueValidationError }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }
    }

    if (!prompt && !notionQueue) {
      return new Response(JSON.stringify({ error: "Prompt or notionQueue intake is required" }), {
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

    let resolvedPrompt = prompt;
    let resolvedNotionQueue:
      | {
          databaseId: string;
          pageId: string;
          title: string;
          statusProperty: string;
          runId: string;
          claimedBy: string;
          propertyTypes?: Record<string, string>;
        }
      | undefined;

    if (notionQueue) {
      try {
        const runId = randomUUID();
        const claimedBy =
          process.env.NOTIONMCP_OPERATOR_NAME?.trim() ||
          process.env.USER?.trim() ||
          "Notion MCP Backlog Desk";
        const queueEntry = await claimNextNotionQueueEntry(notionQueue, {
          runId,
          claimedBy,
          ...(activeConnectionId ? { connectionId: activeConnectionId } : {}),
        });
        resolvedPrompt = queueEntry.prompt;
        resolvedNotionQueue = {
          databaseId: notionQueue.databaseId,
          pageId: queueEntry.pageId,
          title: queueEntry.title,
          statusProperty: notionQueue.statusProperty,
          runId: queueEntry.runId,
          claimedBy: queueEntry.claimedBy,
          ...(activeConnectionId ? { connectionId: activeConnectionId } : {}),
          propertyTypes: queueEntry.propertyTypes,
        };
      } catch (error) {
        return new Response(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message
                : "Could not load a ready Notion queue item via MCP",
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    await assertDurabilityExecutionReadiness();
    try {
      const job = await createDurableJob(
        "research",
        {
          prompt: resolvedPrompt,
          researchMode,
          ...(activeConnectionId ? { notionConnectionId: activeConnectionId } : {}),
          ...(resolvedNotionQueue ? { notionQueue: resolvedNotionQueue } : {}),
        },
        resolvedNotionQueue?.runId
      );
      jobId = job.id;
    } catch (error) {
      if (resolvedNotionQueue) {
        await updateNotionQueueLifecycle(resolvedNotionQueue, {
          stage: "error",
          jobId: resolvedNotionQueue.runId,
          message: error instanceof Error ? error.message : "Failed to create the durable research run.",
        });
      }

      throw error;
    }
  }

  await ensureJobWorker(jobId);
  return createJobEventStreamResponse(jobId, { afterEventId });
}

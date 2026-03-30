import { NextRequest } from "next/server";
import {
  buildApiSurfaceHeaders,
  getQueuePreviewRouteContract,
} from "@/lib/api-surface";
import { createApiErrorResponse } from "@/lib/api-route-errors";
import { getDeploymentReadinessError } from "@/lib/deployment-boundary";
import { ACTIVE_NOTION_CONNECTION_COOKIE_NAME, getActiveNotionConnectionFromRequest } from "@/lib/notion-oauth";
import { previewNotionQueueEntries } from "@/lib/notion-mcp";
import {
  getNotionQueueConfigValidationError,
  normalizeNotionQueueConfig,
} from "@/lib/notion-queue";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const deploymentReadinessError = getDeploymentReadinessError();

  if (deploymentReadinessError) {
    return createApiErrorResponse("queue-introspection", 503, deploymentReadinessError);
  }

  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  return Response.json(getQueuePreviewRouteContract(), {
    headers: buildApiSurfaceHeaders("queue-introspection"),
  });
}

export async function POST(req: NextRequest) {
  const deploymentReadinessError = getDeploymentReadinessError();

  if (deploymentReadinessError) {
    return createApiErrorResponse("queue-introspection", 503, deploymentReadinessError);
  }

  getActiveNotionConnectionFromRequest(req);
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const body = (await req.json()) as Record<string, unknown>;
  const notionQueue = normalizeNotionQueueConfig(body.notionQueue);

  if (!notionQueue) {
    return new Response(
      JSON.stringify({ error: "A notionQueue object with a Notion database ID is required" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...buildApiSurfaceHeaders("queue-introspection"),
        },
      }
    );
  }

  const queueValidationError = getNotionQueueConfigValidationError(notionQueue);

  if (queueValidationError) {
    return new Response(JSON.stringify({ error: queueValidationError }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...buildApiSurfaceHeaders("queue-introspection"),
      },
    });
  }

  try {
    const activeConnectionId = req.cookies.get(ACTIVE_NOTION_CONNECTION_COOKIE_NAME)?.value?.trim() || undefined;
    const preview = await previewNotionQueueEntries(notionQueue, {
      ...(activeConnectionId ? { connectionId: activeConnectionId } : {}),
    });

    return Response.json(preview, {
      headers: buildApiSurfaceHeaders("queue-introspection"),
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Could not inspect the configured Notion queue via MCP",
      }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          ...buildApiSurfaceHeaders("queue-introspection"),
        },
      }
    );
  }
}
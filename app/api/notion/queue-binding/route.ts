import { NextRequest } from "next/server";
import {
  buildApiSurfaceHeaders,
  getNotionQueueBindingRouteContract,
} from "@/lib/api-surface";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  getActiveNotionConnectionFromRequest,
  getNotionConnectionStatus,
} from "@/lib/notion-oauth";
import {
  getNotionQueueConfigValidationError,
  normalizeNotionQueueConfig,
} from "@/lib/notion-queue";
import {
  ACTIVE_NOTION_QUEUE_BINDING_COOKIE_NAME,
  buildNotionQueueBindingCookieValue,
  loadNotionQueueBinding,
  persistNotionQueueBinding,
  readNotionQueueBindingCookie,
} from "@/lib/notion-queue-binding";
import { validateApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const maxDuration = 120;

function buildMissingConnectionResponse(connectionStatus: Awaited<ReturnType<typeof getNotionConnectionStatus>>) {
  return Response.json(
    {
      error: "Connect a Notion workspace first before saving or restoring a queue binding.",
      ...connectionStatus,
      bindingContract: getNotionQueueBindingRouteContract(),
    },
    {
      status: 409,
      headers: buildApiSurfaceHeaders("notion-binding"),
    }
  );
}

export async function GET(req: NextRequest) {
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const activeConnectionId = req.cookies.get(ACTIVE_NOTION_CONNECTION_COOKIE_NAME)?.value?.trim() ?? null;
  const activeConnection = getActiveNotionConnectionFromRequest(req);
  const connectionStatus = await getNotionConnectionStatus(activeConnectionId, activeConnection);

  if (!activeConnectionId || !connectionStatus.activeConnection) {
    return buildMissingConnectionResponse(connectionStatus);
  }

  readNotionQueueBindingCookie(req.cookies.get(ACTIVE_NOTION_QUEUE_BINDING_COOKIE_NAME)?.value);
  const binding = await loadNotionQueueBinding(activeConnectionId);

  return Response.json(
    {
      ...connectionStatus,
      binding,
      bindingContract: getNotionQueueBindingRouteContract(),
    },
    {
      headers: buildApiSurfaceHeaders("notion-binding"),
    }
  );
}

export async function POST(req: NextRequest) {
  const requestError = await validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const activeConnectionId = req.cookies.get(ACTIVE_NOTION_CONNECTION_COOKIE_NAME)?.value?.trim() ?? null;
  const activeConnection = getActiveNotionConnectionFromRequest(req);
  const connectionStatus = await getNotionConnectionStatus(activeConnectionId, activeConnection);

  if (!activeConnectionId || !connectionStatus.activeConnection) {
    return buildMissingConnectionResponse(connectionStatus);
  }

  const body = (await req.json()) as Record<string, unknown>;
  const notionQueue = normalizeNotionQueueConfig(body.notionQueue);

  if (!notionQueue) {
    return Response.json(
      {
        error: "A notionQueue object with a Notion database ID is required.",
      },
      {
        status: 400,
        headers: buildApiSurfaceHeaders("notion-binding"),
      }
    );
  }

  const queueValidationError = getNotionQueueConfigValidationError(notionQueue);

  if (queueValidationError) {
    return Response.json(
      {
        error: queueValidationError,
      },
      {
        status: 400,
        headers: buildApiSurfaceHeaders("notion-binding"),
      }
    );
  }

  const binding = await persistNotionQueueBinding(activeConnectionId, notionQueue);
  const response = Response.json(
    {
      ...connectionStatus,
      binding,
      bindingContract: getNotionQueueBindingRouteContract(),
    },
    {
      headers: buildApiSurfaceHeaders("notion-binding"),
    }
  );

  response.headers.append(
    "Set-Cookie",
    `${ACTIVE_NOTION_QUEUE_BINDING_COOKIE_NAME}=${buildNotionQueueBindingCookieValue(binding)}; Path=/; HttpOnly; SameSite=Lax${req.nextUrl.protocol === "https:" ? "; Secure" : ""}; Max-Age=${60 * 60 * 24 * 30}`
  );

  return response;
}
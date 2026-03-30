import { buildApiSurfaceHeaders, type ApiSurfaceKind } from "@/lib/api-surface";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createApiErrorResponse(
  kind: ApiSurfaceKind,
  status: number,
  error: unknown
): Response {
  return new Response(JSON.stringify({ error: getErrorMessage(error) }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...buildApiSurfaceHeaders(kind),
    },
  });
}

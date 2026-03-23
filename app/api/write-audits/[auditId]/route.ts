import { NextRequest } from "next/server";
import { validateApiRequest } from "@/lib/request-security";
import { loadWriteAuditRecord } from "@/lib/write-audit-store";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    auditId: string;
  }>;
};

export async function GET(req: NextRequest, context: RouteContext) {
  const requestError = validateApiRequest(req);

  if (requestError) {
    return requestError;
  }

  const { auditId } = await context.params;
  const record = await loadWriteAuditRecord(auditId);

  if (!record) {
    return new Response(JSON.stringify({ error: "Write audit not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return Response.json(record);
}

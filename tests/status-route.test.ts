import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as getStatus } from "@/app/api/status/route";
import { createJob, markJobRunning, updateJobRecord } from "@/lib/job-store";
import { persistWriteAuditRecord } from "@/lib/write-audit-store";

const ORIGINAL_ENV = { ...process.env };

function createGetRequest(url: string, headers?: HeadersInit) {
  return new NextRequest(url, {
    method: "GET",
    headers: new Headers({
      host: new URL(url).host,
      ...headers,
    }),
  });
}

test.beforeEach(async () => {
  process.env = {
    ...ORIGINAL_ENV,
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-status-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-status-audits-")),
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("status route reports ready deployment details and persisted runtime counts", async () => {
  const activeJob = await createJob("research", { prompt: "Find CRM competitors" });
  const staleJob = await createJob("write", { summary: "Write audited rows" });
  const writeAudit = await persistWriteAuditRecord({
    status: "complete",
    usedExistingDatabase: false,
    resumedFromIndex: 0,
    providerMode: "direct-api",
    message: "Write audit complete",
    auditTrail: {
      sourceSet: ["https://example.com"],
      extractionCounts: {
        searchQueries: 1,
        candidateSources: 1,
        pagesBrowsed: 1,
        rowsExtracted: 1,
      },
      rejectedUrls: [],
      rowsReviewed: 1,
      rowsAttempted: 1,
      rowsConfirmedWritten: 1,
      rowsConfirmedAfterReconciliation: 0,
      rowsSkippedAsDuplicates: 0,
      rowsLeftUnresolved: 0,
      rows: [
        {
          rowIndex: 0,
          operationKey: "op-1",
          status: "written",
          evidenceSummary: "Evidence for 1 field: Name",
        },
      ],
    },
  });

  await markJobRunning(activeJob.id, { pid: 111 });
  await markJobRunning(staleJob.id, { pid: 222 });
  await updateJobRecord(staleJob.id, (record) => ({
    ...record,
    worker: record.worker
      ? {
          ...record.worker,
          heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
        }
      : record.worker,
  }));

  const response = await getStatus(createGetRequest("http://localhost:3000/api/status"));
  const payload = (await response.json()) as {
    ready: boolean;
    deployment: {
      mode: string;
      durableExecutionMode: string;
      readinessError: string | null;
    };
    providerArchitecture: {
      mode: string;
    };
    runtime: {
      jobs: {
        total: number;
        byKind: Record<string, number>;
        byStatus: Record<string, number>;
        activeWorkers: number;
        staleWorkers: number;
      };
      writeAudits: {
        total: number;
        byStatus: Record<string, number>;
      };
    };
    statusContract: {
      kind: string;
      route: string;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "system-status");
  assert.equal(response.headers.get("x-notionmcp-provider-mode"), "direct-api");
  assert.equal(payload.ready, true);
  assert.equal(payload.deployment.mode, "localhost-operator");
  assert.equal(payload.deployment.readinessError, null);
  assert.equal(payload.providerArchitecture.mode, "direct-api");
  assert.equal(payload.runtime.jobs.total, 2);
  assert.equal(payload.runtime.jobs.byKind.research, 1);
  assert.equal(payload.runtime.jobs.byKind.write, 1);
  assert.equal(payload.runtime.jobs.byStatus.running, 2);
  assert.equal(payload.runtime.jobs.activeWorkers, 1);
  assert.equal(payload.runtime.jobs.staleWorkers, 1);
  assert.equal(payload.runtime.writeAudits.total, 1);
  assert.equal(payload.runtime.writeAudits.byStatus.complete, 1);
  assert.equal(payload.statusContract.kind, "system-status");
  assert.equal(payload.statusContract.route, "/api/status");
  assert.ok(writeAudit.id);
});

test("status route returns 503 with readiness details when deployment settings are invalid", async () => {
  process.env.NOTIONMCP_DEPLOYMENT_MODE = "remote-private-host";
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  delete process.env.APP_ACCESS_TOKEN;

  const response = await getStatus(createGetRequest("http://localhost:3000/api/status"));
  const payload = (await response.json()) as {
    ready: boolean;
    deployment: {
      readinessError: string | null;
    };
    runtime: {
      jobs: {
        total: number;
      };
      writeAudits: {
        total: number;
      };
    };
  };

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-notionmcp-surface"), "system-status");
  assert.equal(response.headers.get("x-notionmcp-provider-mode"), "direct-api");
  assert.equal(payload.ready, false);
  assert.match(payload.deployment.readinessError ?? "", /APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN/);
  assert.equal(payload.runtime.jobs.total, 0);
  assert.equal(payload.runtime.writeAudits.total, 0);
});

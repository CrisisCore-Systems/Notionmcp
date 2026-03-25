import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as getReady } from "@/app/api/ready/route";
import { observabilityTestOverrides } from "@/lib/observability";

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
  observabilityTestOverrides.reset();
  process.env = {
    ...ORIGINAL_ENV,
    JOB_STATE_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-ready-jobs-")),
    WRITE_AUDIT_DIR: await mkdtemp(path.join(os.tmpdir(), "notionmcp-ready-audits-")),
  };
});

test.afterEach(async () => {
  const directories = [process.env.JOB_STATE_DIR, process.env.WRITE_AUDIT_DIR].filter(Boolean) as string[];
  process.env = { ...ORIGINAL_ENV };
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("health route reports liveness with a machine-readable contract", async () => {
  const response = await getHealth(createGetRequest("http://localhost:3000/api/health"));
  const payload = (await response.json()) as {
    alive: boolean;
    checkedAt: string;
    diagnostics: {
      processStartedAt: string;
    };
    metrics: {
      counters: {
        operatorSurfaceChecks: {
          health: number;
        };
      };
    };
    healthContract: {
      route: string;
      kind: string;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "health-check");
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(payload.alive, true);
  assert.match(payload.checkedAt, /\d{4}-\d{2}-\d{2}T/);
  assert.match(payload.diagnostics.processStartedAt, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.metrics.counters.operatorSurfaceChecks.health, 1);
  assert.equal(payload.healthContract.route, "/api/health");
  assert.equal(payload.healthContract.kind, "health-check");
});

test("ready route reports readiness with a machine-readable contract", async () => {
  const response = await getReady(createGetRequest("http://localhost:3000/api/ready"));
  const payload = (await response.json()) as {
    ready: boolean;
    checkedAt: string;
    error: string | null;
    diagnostics: {
      deploymentMode: string;
      durableExecutionMode: string;
      probes: {
        firstSuccessfulReadyAt: string | null;
      };
    };
    metrics: {
      counters: {
        operatorSurfaceChecks: {
          ready: number;
        };
      };
    };
    readinessContract: {
      route: string;
      kind: string;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-notionmcp-surface"), "readiness-check");
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(payload.ready, true);
  assert.equal(payload.error, null);
  assert.match(payload.checkedAt, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.diagnostics.deploymentMode, "localhost-operator");
  assert.equal(payload.diagnostics.durableExecutionMode, "detached");
  assert.match(payload.diagnostics.probes.firstSuccessfulReadyAt ?? "", /\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.metrics.counters.operatorSurfaceChecks.ready, 1);
  assert.equal(payload.readinessContract.route, "/api/ready");
  assert.equal(payload.readinessContract.kind, "readiness-check");
});

test("ready route returns 503 when remote-private-host deployment settings are invalid", async () => {
  process.env.NOTIONMCP_DEPLOYMENT_MODE = "remote-private-host";
  process.env.APP_ALLOWED_ORIGIN = "https://app.example.com";
  delete process.env.APP_ACCESS_TOKEN;

  const response = await getReady(createGetRequest("http://localhost:3000/api/ready"));
  const payload = (await response.json()) as {
    ready: boolean;
    error: string | null;
  };

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-notionmcp-surface"), "readiness-check");
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(payload.ready, false);
  assert.match(payload.error ?? "", /APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN/);
});

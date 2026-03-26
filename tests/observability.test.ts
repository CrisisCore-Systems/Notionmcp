import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getOperatorMetricsSnapshot,
  incrementMetric,
  observabilityTestOverrides,
  recordOperatorSurfaceCheck,
} from "@/lib/observability";

const ORIGINAL_ENV = { ...process.env };

test.afterEach(async () => {
  const metricsPath = process.env.OPERATOR_METRICS_PATH;
  process.env = { ...ORIGINAL_ENV };
  observabilityTestOverrides.reset({ clearPersistedMetrics: true });

  if (metricsPath) {
    await rm(path.dirname(metricsPath), { recursive: true, force: true });
  }
});

test("operator metrics reload from the persisted sink after a simulated worker restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notionmcp-observability-"));
  const metricsPath = path.join(directory, "operator-metrics.json");

  process.env = {
    ...ORIGINAL_ENV,
    OPERATOR_METRICS_PATH: metricsPath,
  };
  observabilityTestOverrides.reset({ clearPersistedMetrics: true });

  incrementMetric("jobsCreated", 2);
  incrementMetric("queueClaimContention");
  recordOperatorSurfaceCheck("status");
  const snapshotBeforeRestart = getOperatorMetricsSnapshot();

  observabilityTestOverrides.reloadPersistedMetrics();
  const snapshotAfterRestart = getOperatorMetricsSnapshot();

  assert.equal(snapshotAfterRestart.startedAt, snapshotBeforeRestart.startedAt);
  assert.equal(snapshotAfterRestart.counters.jobsCreated, 2);
  assert.equal(snapshotAfterRestart.counters.queueClaimContention, 1);
  assert.equal(snapshotAfterRestart.counters.operatorSurfaceChecks.status, 1);
});

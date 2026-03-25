import { getResearchProfile } from "@/lib/agent";
import {
  getDeploymentMode,
  getDurableExecutionMode,
  type DeploymentMode,
  type DurableExecutionMode,
} from "@/lib/deployment-boundary";
import { getCurrentNotionProviderState } from "@/lib/notion";
import {
  DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY,
  DEFAULT_NOTION_QUEUE_READY_VALUE,
  DEFAULT_NOTION_QUEUE_STATUS_PROPERTY,
  DEFAULT_NOTION_QUEUE_TITLE_PROPERTY,
} from "@/lib/notion-queue";

export type ApiSurfaceKind =
  | "research-control"
  | "write-control"
  | "health-check"
  | "readiness-check"
  | "system-status"
  | "durable-job-verification"
  | "write-audit-verification";

type ApiSurfaceContext = {
  deploymentMode: DeploymentMode;
  durableExecutionMode: DurableExecutionMode;
};

const JOB_VERIFICATION_ROUTE = "/api/jobs/{jobId}";
const WRITE_AUDIT_VERIFICATION_ROUTE = "/api/write-audits/{auditId}";

function getApiSurfaceContext(env: NodeJS.ProcessEnv = process.env): ApiSurfaceContext {
  return {
    deploymentMode: getDeploymentMode(env),
    durableExecutionMode: getDurableExecutionMode(env),
  };
}

function getDeploymentBoundaryContract(context: ApiSurfaceContext) {
  return {
    mode: context.deploymentMode,
    durableExecutionMode: context.durableExecutionMode,
    workstationGuarantees:
      "localhost-operator mode is the workstation path: local-only requests, bounded fast research by default, and inline degradation only when the host is declared inline-only.",
    remotePrivateHostRequirements: [
      "Set NOTIONMCP_DEPLOYMENT_MODE=remote-private-host intentionally",
      "Configure APP_ALLOWED_ORIGIN and APP_ACCESS_TOKEN together",
      "Set PERSISTED_STATE_ENCRYPTION_KEY so persisted job and audit state is encrypted at rest",
      "Keep detached durable jobs enabled on a long-lived Node host with writable local state",
    ],
  };
}

export function buildApiSurfaceHeaders(
  kind: ApiSurfaceKind,
  env: NodeJS.ProcessEnv = process.env
): HeadersInit {
  const context = getApiSurfaceContext(env);
  const providerState =
    kind === "write-control" || kind === "write-audit-verification" || kind === "system-status"
      ? getCurrentNotionProviderState(env)
      : null;

  return {
    "Cache-Control": "no-store",
    "x-notionmcp-surface": kind,
    "x-notionmcp-deployment-mode": context.deploymentMode,
    "x-notionmcp-durable-execution": context.durableExecutionMode,
    ...(providerState ? { "x-notionmcp-provider-mode": providerState.mode } : {}),
  };
}

export function getResearchRouteContract(env: NodeJS.ProcessEnv = process.env) {
  const context = getApiSurfaceContext(env);
  const fast = getResearchProfile("fast");
  const deep = getResearchProfile("deep");

  return {
    route: "/api/research",
    kind: "research-control",
    createsDurableJob: true,
    verificationArtifacts: [JOB_VERIFICATION_ROUTE],
    workflow: {
      controlPlane: "Notion workspace",
      defaultEntry: "notion-mcp-queue",
      reviewedLoop: [
        "pull the next ready backlog item from Notion via MCP",
        "run reviewed fast or deep research",
        "let the operator approve edits",
        "write the reviewed output back into Notion",
      ],
    },
    notionQueueIntake: {
      enabled: true,
      transport: "local-mcp",
      defaults: {
        promptProperty: DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY,
        titleProperty: DEFAULT_NOTION_QUEUE_TITLE_PROPERTY,
        statusProperty: DEFAULT_NOTION_QUEUE_STATUS_PROPERTY,
        readyValue: DEFAULT_NOTION_QUEUE_READY_VALUE,
      },
    },
    researchModes: {
      default: fast.mode,
      available: [
        {
          mode: fast.mode,
          intent: "bounded fast lane",
          maxPlannedQueries: fast.maxPlannedQueries,
          maxBrowsePerQuery: fast.maxBrowsePerQuery,
          maxEvidenceDocuments: fast.maxEvidenceDocuments,
        },
        {
          mode: deep.mode,
          intent: "higher-budget deep lane",
          minPlannedQueries: deep.minPlannedQueries,
          maxPlannedQueries: deep.maxPlannedQueries,
          maxBrowsePerQuery: deep.maxBrowsePerQuery,
          maxEvidenceDocuments: deep.maxEvidenceDocuments,
          minUniqueDomains: deep.minUniqueDomains,
          minSourceClasses: deep.minSourceClasses,
          maxPerDomain: deep.maxPerDomain,
        },
      ],
    },
    deploymentBoundary: getDeploymentBoundaryContract(context),
  };
}

export function getWriteRouteContract(env: NodeJS.ProcessEnv = process.env) {
  const context = getApiSurfaceContext(env);
  const providerState = getCurrentNotionProviderState(env);

  return {
    route: "/api/write",
    kind: "write-control",
    createsDurableJob: true,
    verificationArtifacts: [JOB_VERIFICATION_ROUTE, WRITE_AUDIT_VERIFICATION_ROUTE],
    providerArchitecture: providerState,
    writeGuarantees: [
      "Reviewed rows are written back to the Notion workspace of record only after operator approval.",
      "Writes are resumable with row checkpoints and deterministic operation keys.",
      "Write audits persist as first-class verification artifacts outside transient UI state.",
    ],
    deploymentBoundary: getDeploymentBoundaryContract(context),
  };
}

export function getJobVerificationContract(env: NodeJS.ProcessEnv = process.env) {
  const context = getApiSurfaceContext(env);

  return {
    route: JOB_VERIFICATION_ROUTE,
    kind: "durable-job-verification",
    verificationArtifact: "durable job state",
    includes: [
      "persisted job payload",
      "replayable event log",
      "checkpoint metadata for resumable work",
      "terminal result or error state",
      "artifact integrity metadata with chained event hashes and HMAC attestation",
    ],
    artifactIntegrity: {
      status: "hmac-sha256-attested",
      fields: ["recordHash", "previousHash", "mac", "keyId", "signedAt", "finalEventChainHash"],
    },
    deploymentBoundary: getDeploymentBoundaryContract(context),
  };
}

export function getWriteAuditVerificationContract(env: NodeJS.ProcessEnv = process.env) {
  const context = getApiSurfaceContext(env);
  const providerState = getCurrentNotionProviderState(env);

  return {
    route: WRITE_AUDIT_VERIFICATION_ROUTE,
    kind: "write-audit-verification",
    verificationArtifact: "write audit trail",
    includes: [
      "reviewed source set",
      "row-level operation-key outcomes",
      "reconciliation results",
      "provider lane used for the write",
      "artifact integrity metadata with HMAC attestation",
    ],
    artifactIntegrity: {
      status: "hmac-sha256-attested",
      fields: [
        "recordHash",
        "previousHash",
        "mac",
        "keyId",
        "signedAt",
        "sourceSetHash",
        "rowOutcomesHash",
        "auditPayloadHash",
      ],
    },
    providerArchitecture: providerState,
    deploymentBoundary: getDeploymentBoundaryContract(context),
  };
}

export function getStatusRouteContract(env: NodeJS.ProcessEnv = process.env) {
  const context = getApiSurfaceContext(env);
  const providerState = getCurrentNotionProviderState(env);

  return {
    route: "/api/status",
    kind: "system-status",
    reports: [
      "deployment readiness",
      "durable execution mode",
      "persisted job counts by kind and status",
      "worker heartbeat freshness",
      "persisted write-audit counts by status",
      "startup diagnostics summary",
      "operator metrics snapshot",
    ],
    providerArchitecture: providerState,
    deploymentBoundary: getDeploymentBoundaryContract(context),
  };
}

export function getHealthRouteContract(env: NodeJS.ProcessEnv = process.env) {
  const context = getApiSurfaceContext(env);

  return {
    route: "/api/health",
    kind: "health-check",
    livenessSemantics: "Returns 200 when the Node runtime can accept and answer API requests.",
    diagnostics: ["process startup summary", "operator metrics snapshot"],
    deploymentBoundary: getDeploymentBoundaryContract(context),
  };
}

export function getReadinessRouteContract(env: NodeJS.ProcessEnv = process.env) {
  const context = getApiSurfaceContext(env);

  return {
    route: "/api/ready",
    kind: "readiness-check",
    readinessSemantics:
      "Returns 200 only when deployment settings are valid and persisted job/audit directories are writable.",
    diagnostics: ["process startup summary", "deployment readiness summary", "operator metrics snapshot"],
    deploymentBoundary: getDeploymentBoundaryContract(context),
  };
}

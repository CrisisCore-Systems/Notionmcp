"use client";

import { useEffect, useRef, useState } from "react";
import type { ResearchResult } from "@/lib/agent";
import {
  DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY,
  DEFAULT_NOTION_QUEUE_READY_VALUE,
  DEFAULT_NOTION_QUEUE_STATUS_PROPERTY,
  DEFAULT_NOTION_QUEUE_TITLE_PROPERTY,
} from "@/lib/notion-queue";
import { RESEARCH_RUN_METADATA_KEY } from "@/lib/research-result";
import {
  clearActiveJob,
  loadActiveJob,
  saveActiveJob,
  type ActiveJobState,
} from "./chat/active-job-storage";
import {
  buildCsv,
  buildNotionWebUrl,
  getSafeFilename,
  getUniqueColumnName,
  moveArrayItem,
} from "./chat/chat-utils";
import { CompletionPanel } from "./chat/CompletionPanel";
import { RowEditor } from "./chat/RowEditor";
import { SchemaEditor } from "./chat/SchemaEditor";
import { ActivityStatus } from "./chat/ActivityStatus";
import { DRAFT_PERSISTENCE_PREFERENCE_KEY } from "./chat/draft-storage";
import { useApprovalValidation } from "./chat/useApprovalValidation";
import { streamSSE } from "./chat/stream";
import type {
  EditableResult,
  LogEntry,
  PendingWriteResume,
  PropertyType,
  StreamErrorPayload,
  WritePayload,
  WriteSummary,
} from "./chat/types";
import { useDraftPersistence } from "./chat/useDraftPersistence";
import { usePhaseState } from "./chat/usePhaseState";

type ResearchMode = "fast" | "deep";

type ActivitySnapshot = {
  kind: "research" | "write";
  title: string;
  detail: string;
  stage: string;
  percent: number;
  stats: string[];
};

type NotionQueuePreviewEntry = {
  pageId: string;
  title: string;
  status: string;
  prompt: string;
  hasUsablePrompt: boolean;
  isReady: boolean;
  promptSource: "prompt-property" | "title-fallback" | "missing";
};

type NotionQueuePreview = {
  databaseId: string;
  totalEntries: number;
  readyEntries: number;
  usablePromptEntries: number;
  readyWithUsablePromptEntries: number;
  truncated: boolean;
  entries: NotionQueuePreviewEntry[];
  statusCounts: Array<{ status: string; count: number }>;
  propertyChecks: {
    promptProperty: { name: string; exists: boolean; type: string | null };
    titleProperty: { name: string; exists: boolean; type: string | null };
    statusProperty: { name: string; exists: boolean; type: string | null };
  };
};

type LinkedNotionDatabase = {
  databaseId: string;
  title: string;
  url: string | null;
  description: string;
  lastEditedTime: string | null;
  dataSourceId: string | null;
  properties: Array<{ name: string; type: string }>;
  suggestedQueueProperties: {
    promptProperty: string | null;
    titleProperty: string | null;
    statusProperty: string | null;
  };
};

type LinkedNotionParent = {
  pageId: string;
  title: string;
  url: string | null;
  lastEditedTime: string | null;
  parentType: string | null;
};

type LinkedQueueBinding = {
  connectionId: string;
  notionQueue: {
    databaseId: string;
    promptProperty: string;
    titleProperty: string;
    statusProperty: string;
    readyValue: string;
  };
  updatedAt: string;
};

const EXAMPLE_PROMPTS = [
  "Research this backlog item: AI meeting notes assistant for product teams",
  "Research this backlog item: lightweight CRM for solo consultants",
  "Research this backlog item: privacy-first internal wiki for startups",
  "Research this backlog item: customer interview repository with semantic search",
];

const PROPERTY_TYPES: PropertyType[] = ["title", "rich_text", "url", "number", "select"];
const BLOB_URL_CLEANUP_DELAY_MS = 5000;
const ACTION_TIMEOUT_WARNING_THRESHOLD_SECONDS = 100;

function buildJobStateUrl(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}`;
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function buildAppRequestHeaders(accessToken?: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const trimmedToken = accessToken?.trim();

  if (trimmedToken) {
    headers["x-app-access-token"] = trimmedToken;
  }

  return headers;
}

function getQueuePromptSourceLabel(source: NotionQueuePreviewEntry["promptSource"]): string {
  if (source === "prompt-property") {
    return "Prompt field";
  }

  if (source === "title-fallback") {
    return "Title fallback";
  }

  return "No prompt";
}

function getQueuePreviewCardClassName(entry: NotionQueuePreviewEntry): string {
  return entry.isReady && entry.hasUsablePrompt
    ? "queue-preview-card queue-preview-card--ready"
    : "queue-preview-card queue-preview-card--blocked";
}

const PLANNED_SEARCH_QUERIES_RE = /Planned (\d+) search quer(?:y|ies)/i;
const STRUCTURED_ROWS_RE = /Structured (\d+) row/i;
const WRITTEN_ROW_RE = /(?:Added|Skipped) row (\d+) of (\d+)/i;
const RESUME_WRITE_RE = /Resuming Notion write from row (\d+) of (\d+)/i;
const RECONCILED_ROW_RE = /row (\d+) landed/i;
const WRITE_FINISHED_RE = /with (\d+) row(?:s)? written and (\d+) duplicate/i;

function buildResearchActivity(message: string): ActivitySnapshot {
  const normalized = message.trim();
  const plannedMatch = PLANNED_SEARCH_QUERIES_RE.exec(normalized);
  const structuredMatch = STRUCTURED_ROWS_RE.exec(normalized);

  if (/Claimed Notion queue item/i.test(normalized)) {
    return {
      kind: "research",
      title: "Queue item claimed",
      detail: normalized,
      stage: "Backlog row moved into active work",
      percent: 12,
      stats: ["MCP claim confirmed"],
    };
  }

  if (/Planning/i.test(normalized) || plannedMatch) {
    return {
      kind: "research",
      title: "Planning the research path",
      detail: normalized,
      stage: "Building the search strategy",
      percent: plannedMatch ? 24 : 18,
      stats: plannedMatch ? [`${plannedMatch[1]} planned queries`] : [],
    };
  }

  if (/Searching:/i.test(normalized)) {
    return {
      kind: "research",
      title: "Running search queries",
      detail: normalized,
      stage: "Collecting candidate sources",
      percent: 38,
      stats: ["Search providers active"],
    };
  }

  if (/Deep research mode queued/i.test(normalized)) {
    return {
      kind: "research",
      title: "Selecting the review set",
      detail: normalized,
      stage: "Balancing domains and source classes",
      percent: 48,
      stats: ["Deep lane evidence queue"],
    };
  }

  if (/Browsing:/i.test(normalized)) {
    return {
      kind: "research",
      title: "Browsing candidate sources",
      detail: normalized,
      stage: "Reading pages and extracting fields",
      percent: 58,
      stats: ["Browser session active"],
    };
  }

  if (/Captured evidence/i.test(normalized)) {
    return {
      kind: "research",
      title: "Capturing evidence",
      detail: normalized,
      stage: "Adding verified evidence documents",
      percent: 68,
      stats: ["Evidence store growing"],
    };
  }

  if (/Rejected .*source|browse_url failed/i.test(normalized)) {
    return {
      kind: "research",
      title: "Filtering weak or failed sources",
      detail: normalized,
      stage: "Cleaning the evidence set",
      percent: 76,
      stats: ["Low-trust sources removed"],
    };
  }

  if (/Verifying candidate rows|Reconciling extracted rows/i.test(normalized)) {
    return {
      kind: "research",
      title: "Verifying extracted rows",
      detail: normalized,
      stage: "Cross-checking structured output",
      percent: 88,
      stats: ["Evidence verification active"],
    };
  }

  if (/Needs Review/i.test(normalized) || /Moved the original Notion backlog row to Needs Review/i.test(normalized)) {
    return {
      kind: "research",
      title: "Packet ready for operator review",
      detail: normalized,
      stage: "Research completed",
      percent: 100,
      stats: ["Row parked at Needs Review"],
    };
  }

  if (structuredMatch) {
    return {
      kind: "research",
      title: "Structuring the review packet",
      detail: normalized,
      stage: "Finalizing candidate rows",
      percent: 96,
      stats: [pluralize(Number(structuredMatch[1]), "row")],
    };
  }

  return {
    kind: "research",
    title: "Running background research",
    detail: normalized,
    stage: "Processing research job",
    percent: 14,
    stats: [],
  };
}

function buildWriteActivity(message: string): ActivitySnapshot {
  const normalized = message.trim();
  const rowMatch = WRITTEN_ROW_RE.exec(normalized);
  const resumeMatch = RESUME_WRITE_RE.exec(normalized);
  const reconciliationMatch = RECONCILED_ROW_RE.exec(normalized);
  const finishedMatch = WRITE_FINISHED_RE.exec(normalized);

  if (/Using Notion provider lane/i.test(normalized)) {
    return {
      kind: "write",
      title: "Preparing the write lane",
      detail: normalized,
      stage: "Checking provider posture",
      percent: 10,
      stats: ["Audit trail started"],
    };
  }

  if (/Using existing Notion database|Creating Notion database|Created Notion database/i.test(normalized)) {
    return {
      kind: "write",
      title: "Preparing the target database",
      detail: normalized,
      stage: "Validating the write destination",
      percent: /Created Notion database/i.test(normalized) ? 22 : 16,
      stats: ["Target database readying"],
    };
  }

  if (resumeMatch) {
    const current = Number(resumeMatch[1]) - 1;
    const total = Number(resumeMatch[2]);
    return {
      kind: "write",
      title: "Resuming the approved write",
      detail: normalized,
      stage: `Restarting from row ${resumeMatch[1]}`,
      percent: 20 + (current / Math.max(total, 1)) * 60,
      stats: [pluralize(total, "row")],
    };
  }

  if (rowMatch) {
    const current = Number(rowMatch[1]);
    const total = Number(rowMatch[2]);
    const remaining = Math.max(total - current, 0);
    return {
      kind: "write",
      title: "Writing approved rows to Notion",
      detail: normalized,
      stage: `${current}/${total} rows processed`,
      percent: 24 + (current / Math.max(total, 1)) * 64,
      stats: [pluralize(remaining, "row", "rows remaining")],
    };
  }

  if (reconciliationMatch) {
    return {
      kind: "write",
      title: "Reconciling an ambiguous write",
      detail: normalized,
      stage: `Confirmed row ${reconciliationMatch[1]} before resume`,
      percent: 90,
      stats: ["Resume point recalculated"],
    };
  }

  if (/Packet Ready/i.test(normalized)) {
    return {
      kind: "write",
      title: "Backlog row advanced",
      detail: normalized,
      stage: "Row marked Packet Ready",
      percent: 100,
      stats: ["Lifecycle update completed"],
    };
  }

  if (finishedMatch) {
    return {
      kind: "write",
      title: "Write audit finalized",
      detail: normalized,
      stage: "Write complete",
      percent: 100,
      stats: [
        `${finishedMatch[1]} written`,
        `${finishedMatch[2]} duplicate${Number(finishedMatch[2]) === 1 ? "" : "s"} skipped`,
      ],
    };
  }

  return {
    kind: "write",
    title: "Writing in the background",
    detail: normalized,
    stage: "Processing write job",
    percent: 18,
    stats: ["Audit trail active"],
  };
}

function buildActivitySnapshot(kind: "research" | "write", message: string): ActivitySnapshot {
  return kind === "research" ? buildResearchActivity(message) : buildWriteActivity(message);
}

export default function ChatUI() {
  const [prompt, setPrompt] = useState("");
  const [researchMode, setResearchMode] = useState<ResearchMode>("fast");
  const { phase, setPhase, errorMessage, setErrorMessage, lastActionRef, startAction, showApproval, showDone, showError } =
    usePhaseState();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [editedResult, setEditedResult] = useState<EditableResult | null>(null);
  const [history, setHistory] = useState<EditableResult[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [notionUrl, setNotionUrl] = useState<string | null>(null);
  const [writeSummary, setWriteSummary] = useState<WriteSummary | null>(null);
  const [useExistingDatabase, setUseExistingDatabase] = useState(false);
  const [targetDatabaseId, setTargetDatabaseId] = useState("");
  const [useNotionQueue, setUseNotionQueue] = useState(true);
  const [notionQueueDatabaseId, setNotionQueueDatabaseId] = useState("");
  const [notionQueuePromptProperty, setNotionQueuePromptProperty] = useState(
    DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY
  );
  const [notionQueueTitleProperty, setNotionQueueTitleProperty] = useState(
    DEFAULT_NOTION_QUEUE_TITLE_PROPERTY
  );
  const [notionQueueStatusProperty, setNotionQueueStatusProperty] = useState(
    DEFAULT_NOTION_QUEUE_STATUS_PROPERTY
  );
  const [notionQueueReadyValue, setNotionQueueReadyValue] = useState(DEFAULT_NOTION_QUEUE_READY_VALUE);
  const [linkActionMessage, setLinkActionMessage] = useState<string | null>(null);
  const [appAccessToken, setAppAccessToken] = useState("");
  const [pendingWriteResume, setPendingWriteResume] = useState<PendingWriteResume | null>(null);
  const [persistDrafts, setPersistDrafts] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [activeJob, setActiveJob] = useState<ActiveJobState | null>(null);
  const [activitySnapshot, setActivitySnapshot] = useState<ActivitySnapshot | null>(null);
  const [queuePreview, setQueuePreview] = useState<NotionQueuePreview | null>(null);
  const [queuePreviewError, setQueuePreviewError] = useState<string | null>(null);
  const [isQueuePreviewLoading, setIsQueuePreviewLoading] = useState(false);
  const [linkedDatabases, setLinkedDatabases] = useState<LinkedNotionDatabase[]>([]);
  const [linkedDatabasesError, setLinkedDatabasesError] = useState<string | null>(null);
  const [linkedWorkspaceName, setLinkedWorkspaceName] = useState<string | null>(null);
  const [hasActiveLinkedWorkspace, setHasActiveLinkedWorkspace] = useState<boolean | null>(null);
  const [isNotionOAuthConfigured, setIsNotionOAuthConfigured] = useState<boolean | null>(null);
  const [notionOAuthMissingEnvVars, setNotionOAuthMissingEnvVars] = useState<string[]>([]);
  const [notionConnectionStatusError, setNotionConnectionStatusError] = useState<string | null>(null);
  const [isLinkedDatabasesLoading, setIsLinkedDatabasesLoading] = useState(false);
  const [linkedParents, setLinkedParents] = useState<LinkedNotionParent[]>([]);
  const [linkedParentsError, setLinkedParentsError] = useState<string | null>(null);
  const [isLinkedParentsLoading, setIsLinkedParentsLoading] = useState(false);
  const [notionParentPageId, setNotionParentPageId] = useState("");
  const [savedQueueBinding, setSavedQueueBinding] = useState<LinkedQueueBinding | null>(null);
  const [queueBindingMessage, setQueueBindingMessage] = useState<string | null>(null);
  const [isQueueBindingSaving, setIsQueueBindingSaving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const currentWriteJobIdRef = useRef<string | null>(null);
  const logIdRef = useRef(0);
  const historyIndexRef = useRef(-1);
  const timeoutWarningLoggedRef = useRef(false);
  const autoResumeAttemptedRef = useRef(false);
  const queueBindingLoadedRef = useRef(false);
  const startResearchRef = useRef<(jobId?: string) => Promise<void>>(async () => undefined);
  const writeToNotionRef = useRef<(jobId?: string) => Promise<void>>(async () => undefined);

  const { savedDraft, clearSavedDraft, draftPersistenceNotice, draftPersistenceNoticeTone } = useDraftPersistence({
    phase,
    prompt,
    editedResult,
    useExistingDatabase,
    targetDatabaseId,
    notionParentPageId,
    pendingWriteResume,
    persistenceEnabled: persistDrafts,
  });
  const {
    schemaEntries,
    validationIssues,
    invalidCellLookup,
    canWrite,
    approvalHint,
  } = useApprovalValidation({
    editedResult,
    useExistingDatabase,
    targetDatabaseId,
    pendingWriteResume,
  });
  const runMetadata = editedResult?.[RESEARCH_RUN_METADATA_KEY];
  const searchProvidersUsed = runMetadata?.search?.usedProviders ?? [];
  const isDegradedSearchMode = runMetadata?.search?.degraded === true;
  const reviewedResearchMode = runMetadata?.search?.mode ?? researchMode;
  const reviewedProfile = runMetadata?.search?.profile;
  const reviewedUniqueDomainCount = runMetadata?.search?.uniqueDomains?.length ?? 0;
  const reviewedSourceClassCount = runMetadata?.search?.sourceClasses?.length ?? 0;
  const reviewedSourceCount = runMetadata?.sourceSet?.length ?? 0;
  const reviewedRejectedUrlCount = runMetadata?.rejectedUrls?.length ?? 0;
  const isStartActionEnabled = Boolean(
    prompt.trim() || (useNotionQueue && notionQueueDatabaseId.trim())
  );
  const isProcessing = phase === "researching" || phase === "writing";
  const inspectQueueLabel = isQueuePreviewLoading ? "Inspecting queue..." : "Inspect queue";
  const browseLinkedDatabasesLabel = isLinkedDatabasesLoading
    ? "Loading linked databases..."
    : "Browse linked workspace";
  const browseLinkedParentsLabel = isLinkedParentsLoading
    ? "Loading linked parents..."
    : "Browse linked parent pages";
  const saveQueueBindingLabel = isQueueBindingSaving ? "Saving queue setup..." : "Save linked queue setup";
  const isInspectQueueDisabled = !notionQueueDatabaseId.trim() || isQueuePreviewLoading || isProcessing;
  const isSaveQueueBindingDisabled =
    !useNotionQueue || !notionQueueDatabaseId.trim() || isProcessing || isQueueBindingSaving;
  const isQueuePreviewVisible = Boolean(queuePreviewError || queuePreview);
  const canUseLinkedWorkspaceActions = hasActiveLinkedWorkspace === true;
  const isLinkedWorkspaceStatusPending = hasActiveLinkedWorkspace === null;
  const canStartNotionOAuth = isNotionOAuthConfigured === true;
  const isNotionOAuthStatusPending = isNotionOAuthConfigured === null;
  const notionOAuthMissingEnvVarsLabel = notionOAuthMissingEnvVars.join(", ");
  const selectedLinkedDatabase = linkedDatabases.find((database) => database.databaseId === notionQueueDatabaseId) ?? null;
  const selectedLinkedParent = linkedParents.find((parent) => parent.pageId === notionParentPageId) ?? null;
  const missingQueueProperties = queuePreview
    ? Object.values(queuePreview.propertyChecks).filter((property) => !property.exists)
    : [];
  const draftNoticeClassName =
    draftPersistenceNoticeTone === "success"
      ? "operator-card operator-card--warning"
      : draftPersistenceNoticeTone === "privacy"
        ? "operator-card operator-card--blue"
        : "operator-card operator-card--error";

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { id: `log-${logIdRef.current++}`, type, message }]);
  };

  const handleBackgroundUpdate = (kind: "research" | "write", message: string) => {
    addLog(message);
    setActivitySnapshot(buildActivitySnapshot(kind, message));
  };

  const clearActiveJobState = () => {
    clearActiveJob(globalThis.localStorage);
    setActiveJob(null);
  };

  const handleJobEvent = (kind: ActiveJobState["kind"], event: string, data: unknown) => {
    if (event !== "job") {
      return;
    }

    const jobId =
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof (data as { jobId?: unknown }).jobId === "string"
        ? (data as { jobId: string }).jobId.trim()
        : "";

    if (!jobId) {
      return;
    }

    const nextJob = { kind, jobId };
    saveActiveJob(globalThis.localStorage, nextJob);
    setActiveJob(nextJob);

    if (kind === "write") {
      currentWriteJobIdRef.current = jobId;
    }

    if (typeof (data as { status?: unknown }).status === "string") {
      const status = (data as { status: string }).status;
      if (status === "running") {
        setActivitySnapshot((previous) =>
          previous ?? {
            kind,
            title: kind === "research" ? "Durable research job is running" : "Durable write job is running",
            detail: `Job ${jobId} is active on the server.`,
            stage: "Worker attached",
            percent: kind === "research" ? 8 : 10,
            stats: ["Reconnectable SSE stream"],
          }
        );
      }
    }
  };

  const initializeHistory = (result: EditableResult) => {
    setHistory([result]);
    setHistoryIndex(0);
    historyIndexRef.current = 0;
  };

  useEffect(() => {
    const persistedPreference = globalThis.localStorage.getItem(DRAFT_PERSISTENCE_PREFERENCE_KEY);

    if (persistedPreference === "true") {
      setPersistDrafts(true);
    }

    setActiveJob(loadActiveJob(globalThis.localStorage));
  }, []);

  useEffect(() => {
    globalThis.localStorage.setItem(DRAFT_PERSISTENCE_PREFERENCE_KEY, persistDrafts ? "true" : "false");
  }, [persistDrafts]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/notion/connection", {
          headers: buildAppRequestHeaders(appAccessToken),
        });
        const payload = (await response.json()) as {
          error?: string;
          oauth?: { configured?: boolean; missingEnvVars?: string[] } | null;
          activeConnection?: { workspaceName?: string | null } | null;
        };

        if (!response.ok) {
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : `Notion connection status failed with status ${response.status}`
          );
        }

        setIsNotionOAuthConfigured(payload.oauth?.configured === true);
        setNotionOAuthMissingEnvVars(
          Array.isArray(payload.oauth?.missingEnvVars)
            ? payload.oauth?.missingEnvVars.filter((value): value is string => typeof value === "string")
            : []
        );
        setNotionConnectionStatusError(null);

        if (payload.activeConnection && typeof payload.activeConnection.workspaceName === "string") {
          setHasActiveLinkedWorkspace(true);
          setLinkedWorkspaceName(payload.activeConnection.workspaceName);
        } else {
          setHasActiveLinkedWorkspace(false);
          setLinkedWorkspaceName(null);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotionConnectionStatusError(message);
        setIsNotionOAuthConfigured(false);
        setNotionOAuthMissingEnvVars([]);
      }
    })();
  }, [appAccessToken]);

  useEffect(() => {
    if (queueBindingLoadedRef.current) {
      return;
    }

    queueBindingLoadedRef.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/notion/queue-binding", {
          headers: buildAppRequestHeaders(appAccessToken),
        });
        const payload = (await response.json()) as {
          error?: string;
          activeConnection?: { workspaceName?: string | null } | null;
          binding?: LinkedQueueBinding | null;
        };

        if (response.status === 409) {
          setHasActiveLinkedWorkspace(false);
          setLinkedWorkspaceName(null);
          setSavedQueueBinding(null);
          setQueueBindingMessage("Connect a Notion workspace to browse linked databases or save this queue setup.");
          return;
        }

        if (!response.ok) {
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : `Linked queue setup restore failed with status ${response.status}`
          );
        }

        if (payload.activeConnection && typeof payload.activeConnection.workspaceName === "string") {
          setHasActiveLinkedWorkspace(true);
          setLinkedWorkspaceName(payload.activeConnection.workspaceName);
        } else {
          setHasActiveLinkedWorkspace(false);
        }

        if (payload.binding) {
          setUseNotionQueue(true);
          setNotionQueueDatabaseId(payload.binding.notionQueue.databaseId);
          setNotionQueuePromptProperty(payload.binding.notionQueue.promptProperty);
          setNotionQueueTitleProperty(payload.binding.notionQueue.titleProperty);
          setNotionQueueStatusProperty(payload.binding.notionQueue.statusProperty);
          setNotionQueueReadyValue(payload.binding.notionQueue.readyValue);
          setSavedQueueBinding(payload.binding);
          setQueueBindingMessage("Restored the saved queue setup for the linked workspace.");
          addLog(`Restored the saved queue setup for linked workspace ${payload.binding.connectionId}.`, "info");
          return;
        }

        setSavedQueueBinding(null);
        setQueueBindingMessage(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setQueueBindingMessage(`Could not restore the linked queue setup: ${message}`);
        addLog(`Linked queue setup restore failed: ${message}`, "error");
      }
    })();
  }, [appAccessToken]);

  useEffect(() => {
    setQueuePreview(null);
    setQueuePreviewError(null);
  }, [
    useNotionQueue,
    notionQueueDatabaseId,
    notionQueuePromptProperty,
    notionQueueTitleProperty,
    notionQueueStatusProperty,
    notionQueueReadyValue,
  ]);

  useEffect(() => {
    if (phase === "researching" || phase === "writing") {
      setElapsedSeconds(0);
      timeoutWarningLoggedRef.current = false;

      const startedAt = Date.now();
      const interval = globalThis.setInterval(() => {
        const nextElapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        setElapsedSeconds(nextElapsedSeconds);

        if (
          nextElapsedSeconds >= ACTION_TIMEOUT_WARNING_THRESHOLD_SECONDS &&
          !timeoutWarningLoggedRef.current
        ) {
          addLog(
            "⏱️ This request has reached the 100 second warning threshold and is nearing the 120 second timeout limit.",
            "info"
          );
          timeoutWarningLoggedRef.current = true;
        }
      }, 1000);

      return () => globalThis.clearInterval(interval);
    }

    setElapsedSeconds(0);
  }, [phase]);

  useEffect(() => {
    if (!editedResult || !["approving", "error"].includes(phase)) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    globalThis.addEventListener("beforeunload", handleBeforeUnload);
    return () => globalThis.removeEventListener("beforeunload", handleBeforeUnload);
  }, [editedResult, phase]);

  useEffect(() => {
    if (!activeJob || phase !== "idle" || autoResumeAttemptedRef.current) {
      return;
    }

    autoResumeAttemptedRef.current = true;
    addLog(`Reconnecting to the active ${activeJob.kind} job ${activeJob.jobId}...`, "info");

    if (activeJob.kind === "research") {
      void startResearchRef.current(activeJob.jobId);
      return;
    }

    void writeToNotionRef.current(activeJob.jobId);
  }, [activeJob, phase]);

  const updateEditedResult = (
    updater: (previous: EditableResult) => EditableResult
  ) => {
    setEditedResult((previous) => {
      if (!previous) return previous;

      const next = updater(previous);
      if (next === previous) return previous;

      setHistory((currentHistory) => {
        const baseHistory = currentHistory.slice(0, historyIndexRef.current + 1);
        return [...baseHistory, next];
      });
      setHistoryIndex((currentIndex) => {
        const nextIndex = currentIndex + 1;
        historyIndexRef.current = nextIndex;
        return nextIndex;
      });

      return next;
    });
  };

  const restoreSavedDraft = () => {
    if (!savedDraft) return;

    setPrompt(savedDraft.prompt);
    setEditedResult(savedDraft.editedResult);
    initializeHistory(savedDraft.editedResult);
    setUseExistingDatabase(savedDraft.useExistingDatabase);
    setTargetDatabaseId(savedDraft.targetDatabaseId);
    setNotionParentPageId(savedDraft.notionParentPageId);
    setPendingWriteResume(savedDraft.pendingWriteResume ?? null);
    setNotionUrl(null);
    setWriteSummary(null);
    setErrorMessage(null);
    setPhase("approving");
    addLog("Restored your saved draft.", "success");
  };

  const dismissSavedDraft = () => {
    clearSavedDraft();
  };

  const undoEdit = () => {
    if (historyIndex <= 0) return;

    const previousIndex = historyIndex - 1;
    setHistoryIndex(previousIndex);
    historyIndexRef.current = previousIndex;
    setEditedResult(history[previousIndex] ?? null);
  };

  const redoEdit = () => {
    if (historyIndex >= history.length - 1) return;

    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    historyIndexRef.current = nextIndex;
    setEditedResult(history[nextIndex] ?? null);
  };

  const loadQueuePreview = async () => {
    if (!useNotionQueue || !notionQueueDatabaseId.trim()) {
      return;
    }

    setIsQueuePreviewLoading(true);
    setQueuePreviewError(null);

    try {
      const response = await fetch("/api/notion-queue/preview", {
        method: "POST",
        headers: buildAppRequestHeaders(appAccessToken),
        body: JSON.stringify({
          notionQueue: {
            databaseId: notionQueueDatabaseId.trim(),
            promptProperty: notionQueuePromptProperty.trim(),
            titleProperty: notionQueueTitleProperty.trim(),
            statusProperty: notionQueueStatusProperty.trim(),
            readyValue: notionQueueReadyValue.trim(),
          },
        }),
      });
      const payload = (await response.json()) as NotionQueuePreview | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Queue preview failed with status ${response.status}`
        );
      }

      setQueuePreview(payload as NotionQueuePreview);
      addLog(
        `Loaded ${pluralize((payload as NotionQueuePreview).totalEntries, "queue row")} from ${notionQueueDatabaseId.trim()}.`,
        "info"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setQueuePreview(null);
      setQueuePreviewError(message);
      addLog(`Queue preview failed: ${message}`, "error");
    } finally {
      setIsQueuePreviewLoading(false);
    }
  };

  const applyLinkedDatabase = (database: LinkedNotionDatabase) => {
    setNotionQueueDatabaseId(database.databaseId);

    if (database.suggestedQueueProperties.promptProperty) {
      setNotionQueuePromptProperty(database.suggestedQueueProperties.promptProperty);
    }

    if (database.suggestedQueueProperties.titleProperty) {
      setNotionQueueTitleProperty(database.suggestedQueueProperties.titleProperty);
    }

    if (database.suggestedQueueProperties.statusProperty) {
      setNotionQueueStatusProperty(database.suggestedQueueProperties.statusProperty);
    }

    addLog(`Selected linked database ${database.title} (${database.databaseId}).`, "info");
  };

  const saveQueueBinding = async () => {
    if (!useNotionQueue || !notionQueueDatabaseId.trim()) {
      return;
    }

    setIsQueueBindingSaving(true);

    try {
      const response = await fetch("/api/notion/queue-binding", {
        method: "POST",
        headers: buildAppRequestHeaders(appAccessToken),
        body: JSON.stringify({
          notionQueue: {
            databaseId: notionQueueDatabaseId.trim(),
            promptProperty: notionQueuePromptProperty.trim(),
            titleProperty: notionQueueTitleProperty.trim(),
            statusProperty: notionQueueStatusProperty.trim(),
            readyValue: notionQueueReadyValue.trim(),
          },
        }),
      });
      const payload = (await response.json()) as { error?: string; binding?: LinkedQueueBinding | null };

      if (!response.ok) {
        if (response.status === 409) {
          setHasActiveLinkedWorkspace(false);
          setLinkedDatabases([]);
          setLinkedWorkspaceName(null);
          setLinkedDatabasesError(null);
          setQueueBindingMessage("Connect a Notion workspace to browse linked databases or save this queue setup.");
          return;
        }

        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Saving the linked queue setup failed with status ${response.status}`
        );
      }

      if (payload.binding) {
        setSavedQueueBinding(payload.binding);
      }

      setQueueBindingMessage("Saved this queue setup for the active linked workspace.");
      addLog(`Saved the queue setup for linked workspace ${payload.binding?.connectionId ?? "active"}.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setQueueBindingMessage(`Could not save the linked queue setup: ${message}`);
      addLog(`Linked queue setup save failed: ${message}`, "error");
    } finally {
      setIsQueueBindingSaving(false);
    }
  };

  const loadLinkedDatabases = async () => {
    setIsLinkedDatabasesLoading(true);
    setLinkedDatabasesError(null);

    try {
      const response = await fetch("/api/notion/databases", {
        headers: buildAppRequestHeaders(appAccessToken),
      });
      const payload = (await response.json()) as {
        error?: string;
        activeConnection?: { workspaceName?: string | null } | null;
        databases?: LinkedNotionDatabase[];
      };

      if (response.status === 409) {
        setHasActiveLinkedWorkspace(false);
        setLinkedDatabases([]);
        setLinkedWorkspaceName(null);
        setLinkedDatabasesError(null);
        setQueueBindingMessage("Connect a Notion workspace to browse linked databases or save this queue setup.");
        return;
      }

      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Linked database discovery failed with status ${response.status}`
        );
      }

      const databases = Array.isArray(payload.databases) ? payload.databases : [];
      setHasActiveLinkedWorkspace(true);
      setLinkedDatabases(databases);
      setLinkedWorkspaceName(
        payload.activeConnection && typeof payload.activeConnection.workspaceName === "string"
          ? payload.activeConnection.workspaceName
          : null
      );

      if (databases.length > 0 && !databases.some((database) => database.databaseId === notionQueueDatabaseId)) {
        applyLinkedDatabase(databases[0]);
      }

      addLog(`Loaded ${pluralize(databases.length, "linked database")} from the connected Notion workspace.`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLinkedDatabases([]);
      setLinkedWorkspaceName(null);
      setLinkedDatabasesError(message);
      addLog(`Linked database discovery failed: ${message}`, "error");
    } finally {
      setIsLinkedDatabasesLoading(false);
    }
  };

  const loadLinkedParents = async () => {
    setIsLinkedParentsLoading(true);
    setLinkedParentsError(null);

    try {
      const response = await fetch("/api/notion/parents", {
        headers: buildAppRequestHeaders(appAccessToken),
      });
      const payload = (await response.json()) as {
        error?: string;
        activeConnection?: { workspaceName?: string | null } | null;
        parents?: LinkedNotionParent[];
      };

      if (response.status === 409) {
        setHasActiveLinkedWorkspace(false);
        setLinkedParents([]);
        setLinkedWorkspaceName(null);
        setNotionParentPageId("");
        setLinkedParentsError(null);
        return;
      }

      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Linked parent discovery failed with status ${response.status}`
        );
      }

      const parents = Array.isArray(payload.parents) ? payload.parents : [];
      setLinkedParents(parents);
      setLinkedWorkspaceName(
        payload.activeConnection && typeof payload.activeConnection.workspaceName === "string"
          ? payload.activeConnection.workspaceName
          : null
      );

      if (parents.length > 0 && !parents.some((parent) => parent.pageId === notionParentPageId)) {
        setNotionParentPageId(parents[0]?.pageId ?? "");
      }

      addLog(`Loaded ${pluralize(parents.length, "linked parent page")} from the connected Notion workspace.`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLinkedParents([]);
      setNotionParentPageId("");
      setLinkedParentsError(message);
      addLog(`Linked parent discovery failed: ${message}`, "error");
    } finally {
      setIsLinkedParentsLoading(false);
    }
  };

  const startResearch = async (jobId?: string) => {
    if (!jobId && !prompt.trim() && (!useNotionQueue || !notionQueueDatabaseId.trim())) return;
    startAction("research");
    if (!jobId) {
      setLogs([]);
      setEditedResult(null);
      setHistory([]);
      setHistoryIndex(-1);
      historyIndexRef.current = -1;
      clearActiveJobState();
      autoResumeAttemptedRef.current = false;
      currentWriteJobIdRef.current = null;
      setActivitySnapshot(null);
    }
    setNotionUrl(null);
    setWriteSummary(null);
    setErrorMessage(null);
    setPendingWriteResume(null);

    try {
        addLog(
          jobId
            ? `Reconnecting to research job ${jobId}...`
            : useNotionQueue
            ? `Processing the next ready Notion item from ${notionQueueDatabaseId.trim()} and claiming it in Notion...`
            : `Starting research: "${prompt}"`,
          "info"
        );

      if (!jobId) {
        setActivitySnapshot({
          kind: "research",
          title: useNotionQueue ? "Claiming the next Ready item" : "Starting the research job",
          detail: useNotionQueue
            ? `Preparing to claim the next Ready row from ${notionQueueDatabaseId.trim()}.`
            : `Preparing research for: ${prompt.trim()}`,
          stage: "Allocating durable research job",
          percent: 6,
          stats: [useNotionQueue ? "Queue-first intake enabled" : "Manual prompt mode"],
        });
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const data = (await streamSSE({
        url: "/api/research",
        body: jobId
          ? { jobId }
          : useNotionQueue
            ? {
                researchMode,
                notionQueue: {
                  databaseId: notionQueueDatabaseId.trim(),
                  promptProperty: notionQueuePromptProperty.trim(),
                  titleProperty: notionQueueTitleProperty.trim(),
                  statusProperty: notionQueueStatusProperty.trim(),
                  readyValue: notionQueueReadyValue.trim(),
                },
              }
            : { prompt, researchMode },
        signal: controller.signal,
        accessToken: appAccessToken,
        onUpdate: (msg) => handleBackgroundUpdate("research", msg),
        onEvent: (event, data) => handleJobEvent("research", event, data),
      })) as ResearchResult;

      const nextResult = {
        ...data,
        schema: data.schema as Record<string, PropertyType>,
      };
      setEditedResult(nextResult);
      initializeHistory(nextResult);
      clearActiveJobState();
      setActivitySnapshot({
        kind: "research",
        title: "Research packet ready",
        detail: `Structured ${data.items.length} row${data.items.length === 1 ? "" : "s"} and moved the backlog row to Needs Review.`,
        stage: "Awaiting operator approval",
        percent: 100,
        stats: [pluralize(data.items.length, "row")],
      });
      addLog(`✅ Research complete — found ${data.items.length} items`, "success");
      showApproval();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        addLog("Research cancelled.", "info");
        clearActiveJobState();
        setActivitySnapshot(null);
        setPhase("idle");
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      clearActiveJobState();
      setActivitySnapshot((previous) =>
        previous
          ? {
              ...previous,
              detail: message,
              stage: "Research failed",
            }
          : null
      );
      addLog(`Error: ${message}`, "error");
      showError(message);
    } finally {
      abortRef.current = null;
    }
  };

  const writeToNotion = async (jobId?: string) => {
    if (!jobId && (!editedResult || !canWrite)) return;
    startAction("write");
    setWriteSummary(null);
    const resumeTarget = pendingWriteResume;
    const shouldResumeWrite = !!resumeTarget;
    const editedItemCount = editedResult?.items.length ?? 0;

    const payload: WritePayload = shouldResumeWrite
      ? {
          ...(editedResult as EditableResult),
          targetDatabaseId: resumeTarget.databaseId,
          resumeFromIndex: resumeTarget.nextRowIndex,
        }
      : useExistingDatabase && targetDatabaseId.trim()
        ? { ...(editedResult as EditableResult), targetDatabaseId: targetDatabaseId.trim() }
        : {
            ...(editedResult as EditableResult),
            ...(notionParentPageId.trim() ? { notionParentPageId: notionParentPageId.trim() } : {}),
          };

    try {
      addLog(
        jobId
          ? `Reconnecting to write job ${jobId}...`
          : shouldResumeWrite
            ? `Resuming Notion write from row ${resumeTarget.nextRowIndex + 1}...`
          : useExistingDatabase
            ? `Appending ${editedItemCount} row${editedItemCount === 1 ? "" : "s"} to an existing Notion database...`
            : "Starting Notion write phase...",
        "info"
      );

      if (!jobId) {
        setActivitySnapshot({
          kind: "write",
          title: shouldResumeWrite ? "Resuming the approved write" : "Preparing Notion write-back",
          detail: shouldResumeWrite
            ? `Resuming from row ${resumeTarget.nextRowIndex + 1}.`
            : useExistingDatabase
              ? `Appending ${editedItemCount} reviewed row${editedItemCount === 1 ? "" : "s"} to an existing Notion database.`
              : `Creating a reviewed Notion database for ${editedItemCount} row${editedItemCount === 1 ? "" : "s"}.`,
          stage: "Allocating durable write job",
          percent: 8,
          stats: [pluralize(editedItemCount, "row")],
        });
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const data = (await streamSSE({
        url: "/api/write",
        body: jobId ? { jobId } : payload,
        signal: controller.signal,
        accessToken: appAccessToken,
        onUpdate: (msg) => handleBackgroundUpdate("write", msg),
        onEvent: (event, data) => handleJobEvent("write", event, data),
      })) as {
        databaseId: string;
        message: string;
        itemsWritten: number;
        propertyCount: number;
        usedExistingDatabase: boolean;
        providerMode?: string;
        auditId?: string;
        auditUrl?: string;
        auditTrail?: WriteSummary["auditTrail"];
      };

      clearActiveJobState();
      setActivitySnapshot({
        kind: "write",
        title: "Notion write complete",
        detail: data.message,
        stage: "Audit and links ready",
        percent: 100,
        stats: [pluralize(data.itemsWritten, "row"), `${data.propertyCount} properties`],
      });
      addLog(data.message, "success");
      if (data.auditUrl) {
        addLog(`🧾 Write audit saved at ${data.auditUrl}`, "info");
      }
      setNotionUrl(buildNotionWebUrl(data.databaseId));
      setLinkActionMessage(null);
      setPendingWriteResume(null);
      setWriteSummary({
        jobId: currentWriteJobIdRef.current ?? undefined,
        jobUrl: currentWriteJobIdRef.current ? buildJobStateUrl(currentWriteJobIdRef.current) : undefined,
        databaseId: data.databaseId,
        itemsWritten: data.itemsWritten,
        propertyCount: data.propertyCount,
        usedExistingDatabase: data.usedExistingDatabase,
        providerMode: data.providerMode,
        auditId: data.auditId,
        auditUrl: data.auditUrl,
        auditTrail: data.auditTrail,
        ...(runMetadata?.notionQueue
          ? {
              notionQueue: {
                databaseId: runMetadata.notionQueue.databaseId,
                pageId: runMetadata.notionQueue.pageId,
                title: runMetadata.notionQueue.title,
                claimedBy: runMetadata.notionQueue.claimedBy,
                claimedAt: runMetadata.notionQueue.claimedAt,
                runId: runMetadata.notionQueue.runId,
              },
            }
          : {}),
        research: {
          mode: runMetadata?.search?.mode,
          degraded: runMetadata?.search?.degraded === true,
          uniqueDomainCount: runMetadata?.search?.uniqueDomains?.length ?? 0,
          sourceClassCount: runMetadata?.search?.sourceClasses?.length ?? 0,
          averageQualityScore: runMetadata?.search?.sourceQuality?.averageScore,
          rejectedUrlCount: runMetadata?.rejectedUrls?.length ?? 0,
          usedProviders: runMetadata?.search?.usedProviders ?? [],
        },
      });
      clearSavedDraft();
      showDone();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        addLog("Notion write cancelled.", "info");
        clearActiveJobState();
        setActivitySnapshot(null);
        showApproval();
        return;
      }

      const details =
        err instanceof Error && "details" in err
          ? (err as Error & { details?: StreamErrorPayload }).details
          : undefined;
      const message = err instanceof Error ? err.message : String(err);
      clearActiveJobState();
      setActivitySnapshot((previous) =>
        previous
          ? {
              ...previous,
              detail: message,
              stage: pendingWriteResume ? "Write paused with resume point" : "Write failed",
            }
          : null
      );
      if (
        details?.databaseId &&
        typeof details.nextRowIndex === "number" &&
        Number.isInteger(details.nextRowIndex) &&
        details.nextRowIndex >= 0
      ) {
        setPendingWriteResume({
          databaseId: details.databaseId,
          nextRowIndex: details.nextRowIndex,
        });
        addLog(
          `Partial write preserved. Retry will resume from row ${details.nextRowIndex + 1}.`,
          "info"
        );
        setErrorMessage(`${message} Retry last step to resume from row ${details.nextRowIndex + 1}.`);
      } else {
        setPendingWriteResume(null);
        setErrorMessage(message);
      }
      if (details?.auditUrl) {
        addLog(`🧾 Write audit saved at ${details.auditUrl}`, "info");
      }

      addLog(`Error: ${message}`, "error");
      showError(message);
    } finally {
      abortRef.current = null;
    }
  };

  startResearchRef.current = startResearch;
  writeToNotionRef.current = writeToNotion;

  const updateSummary = (summary: string) => {
    updateEditedResult((previous) => ({ ...previous, summary }));
  };

  const updateItemValue = (rowIndex: number, column: string, value: string) => {
    updateEditedResult((previous) => ({
      ...previous,
      items: previous.items.map((item, index) => (index === rowIndex ? { ...item, [column]: value } : item)),
    }));
  };

  const removeItem = (rowIndex: number) => {
    updateEditedResult((previous) => ({
      ...previous,
      items: previous.items.filter((_, index) => index !== rowIndex),
    }));
  };

  const duplicateItem = (rowIndex: number) => {
    updateEditedResult((previous) => {
      const item = previous.items[rowIndex];
      if (!item) return previous;

      return {
        ...previous,
        items: [
          ...previous.items.slice(0, rowIndex + 1),
          { ...item },
          ...previous.items.slice(rowIndex + 1),
        ],
      };
    });
  };

  const moveItem = (rowIndex: number, direction: -1 | 1) => {
    updateEditedResult((previous) => {
      const nextIndex = rowIndex + direction;
      if (nextIndex < 0 || nextIndex >= previous.items.length) {
        return previous;
      }

      return {
        ...previous,
        items: moveArrayItem(previous.items, rowIndex, nextIndex),
      };
    });
  };

  const addColumn = () => {
    updateEditedResult((previous) => {
      const columnName = getUniqueColumnName("New Field", previous.schema);

      return {
        ...previous,
        schema: {
          ...previous.schema,
          [columnName]: "rich_text",
        },
        items: previous.items.map((item) => ({ ...item, [columnName]: "" })),
      };
    });
  };

  const renameColumn = (currentName: string, requestedName: string) => {
    updateEditedResult((previous) => {
      const nextName = getUniqueColumnName(requestedName, previous.schema, currentName);
      if (nextName === currentName) {
        return previous;
      }

      const nextSchema = Object.fromEntries(
        Object.entries(previous.schema).map(([name, type]) => [
          name === currentName ? nextName : name,
          type,
        ])
      ) as Record<string, PropertyType>;

      const nextItems = previous.items.map((item) => {
        const { [currentName]: currentValue = "", ...rest } = item;
        return {
          ...rest,
          [nextName]: currentValue,
        };
      });

      return {
        ...previous,
        schema: nextSchema,
        items: nextItems,
      };
    });
  };

  const updateColumnType = (columnName: string, nextType: PropertyType) => {
    updateEditedResult((previous) => {
      const nextSchema = { ...previous.schema };

      if (nextType === "title") {
        for (const key of Object.keys(nextSchema)) {
          if (nextSchema[key] === "title") {
            nextSchema[key] = "rich_text";
          }
        }
      }

      nextSchema[columnName] = nextType;

      return {
        ...previous,
        schema: nextSchema,
      };
    });
  };

  const deleteColumn = (columnName: string) => {
    updateEditedResult((previous) => {
      const nextSchema = { ...previous.schema };
      delete nextSchema[columnName];

      return {
        ...previous,
        schema: nextSchema,
        items: previous.items.map((item) => {
          const rest = { ...item };
          delete rest[columnName];
          return rest;
        }),
      };
    });
  };

  const downloadFile = (filename: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_CLEANUP_DELAY_MS);
  };

  const exportJson = () => {
    if (!editedResult) return;

    const payload: WritePayload = pendingWriteResume
      ? {
          ...editedResult,
          targetDatabaseId: pendingWriteResume.databaseId,
          resumeFromIndex: pendingWriteResume.nextRowIndex,
        }
      : useExistingDatabase && targetDatabaseId.trim()
        ? { ...editedResult, targetDatabaseId: targetDatabaseId.trim() }
        : {
            ...editedResult,
            ...(notionParentPageId.trim() ? { notionParentPageId: notionParentPageId.trim() } : {}),
          };

    downloadFile(
      `${getSafeFilename(editedResult.suggestedDbTitle, "research-results")}.json`,
      `${JSON.stringify(payload, null, 2)}\n`,
      "application/json"
    );
  };

  const exportCsv = () => {
    if (!editedResult) return;

    downloadFile(
      `${getSafeFilename(editedResult.suggestedDbTitle, "research-results")}.csv`,
      buildCsv(editedResult),
      "text/csv;charset=utf-8"
    );
  };

  const replaceAcrossRows = () => {
    if (!findText || !editedResult) return;

    updateEditedResult((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        Object.fromEntries(
          Object.entries(item).map(([columnName, value]) => [
            columnName,
            typeof value === "string" ? value.replaceAll(findText, replaceText) : value,
          ])
        )
      ),
    }));
    addLog(`Replaced "${findText}" across ${editedResult.items.length} row(s).`, "success");
    setFindText("");
    setReplaceText("");
    setShowFindReplace(false);
  };

  const cancelCurrentAction = () => {
    abortRef.current?.abort();
  };

  const copyNotionLink = async () => {
    if (!notionUrl) return;

    try {
      await navigator.clipboard.writeText(notionUrl);
      setLinkActionMessage("Copied a Notion link you can open on Android, desktop, or the web");
    } catch {
      setLinkActionMessage("Could not copy automatically. Long-press the Notion link to copy it on Android");
    }
  };

  const shareNotionLink = async () => {
    if (!notionUrl || typeof navigator.share !== "function") return;

    try {
      await navigator.share({
        title: "Open updated row",
        text: "Open this updated Notion row",
        url: notionUrl,
      });
      setLinkActionMessage("Shared the Notion link. Choose the Notion app on Android if it appears");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      setLinkActionMessage("Sharing was unavailable. Copy the link and paste or share it into Notion");
    }
  };

  const retryLastAction = () => {
    if (!lastActionRef.current) return;

    if (lastActionRef.current === "write") {
      void writeToNotion();
      return;
    }

    void startResearch();
  };

  const reset = () => {
    abortRef.current?.abort();
    setPhase("idle");
    setLogs([]);
    setEditedResult(null);
    setHistory([]);
    setHistoryIndex(-1);
    historyIndexRef.current = -1;
    setNotionUrl(null);
    setWriteSummary(null);
    setErrorMessage(null);
    setUseExistingDatabase(false);
    setTargetDatabaseId("");
    setNotionParentPageId("");
    setLinkActionMessage(null);
      setPendingWriteResume(null);
      setFindText("");
      setReplaceText("");
      setShowFindReplace(false);
      setPrompt("");
      setUseNotionQueue(true);
      setNotionQueueDatabaseId("");
      setNotionQueuePromptProperty(DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY);
      setNotionQueueTitleProperty(DEFAULT_NOTION_QUEUE_TITLE_PROPERTY);
      setNotionQueueStatusProperty(DEFAULT_NOTION_QUEUE_STATUS_PROPERTY);
      setNotionQueueReadyValue(DEFAULT_NOTION_QUEUE_READY_VALUE);
      setQueuePreview(null);
      setQueuePreviewError(null);
      setIsQueuePreviewLoading(false);
      currentWriteJobIdRef.current = null;
      clearSavedDraft();
    };

  return (
    <div className="workspace-shell" style={{ maxWidth: 960, margin: "0 auto" }}>
      <div className="workspace-head">
        <div>
          <div className="workspace-overline">Research Desk</div>
          <h3 className="workspace-title">Claim, review, and ship the next Notion packet.</h3>
          <p className="workspace-copy">
            Start from the queue claim loop or fall back to a manual prompt. The console below keeps the durable job,
            approval, and write-back mechanics intact while surfacing them in a cleaner operator workspace.
          </p>
        </div>
        <div className="workspace-pulse">Durable job runtime</div>
      </div>

      <section className="operator-card operator-card--muted">
        <div className="operator-card__title">
          Local-first access
        </div>
        <div className="operator-card__copy" style={{ marginBottom: "0.75rem" }}>
          Localhost requests work without extra headers. If you intentionally run this UI against a
          private remote deployment, enter the matching <code>APP_ACCESS_TOKEN</code> so the browser
          can send the required <code>x-app-access-token</code> header.
        </div>
        <label className="operator-checkbox" htmlFor="persist-drafts-checkbox" style={{ marginBottom: "0.75rem" }}>
          <input
            id="persist-drafts-checkbox"
            type="checkbox"
            checked={persistDrafts}
            onChange={(e) => setPersistDrafts(e.target.checked)}
          />
          <span>Enable local draft persistence on this trusted browser for up to 7 days</span>
        </label>
        <label className="operator-label" htmlFor="app-access-token-input">
          App access token (optional)
        </label>
        <input
          id="app-access-token-input"
          type="password"
          value={appAccessToken}
          onChange={(e) => setAppAccessToken(e.target.value)}
          placeholder="Only needed for a tightly controlled remote deployment"
          autoComplete="off"
          className="operator-input"
        />
        {draftPersistenceNotice && (
          <div className={draftNoticeClassName} style={{ marginTop: "0.75rem", marginBottom: 0, padding: "0.75rem 0.85rem" }}>
            {draftPersistenceNotice}
          </div>
        )}
      </section>

      {savedDraft && phase === "idle" && (
        <section className="operator-card operator-card--blue">
          <div className="operator-card__copy" style={{ marginBottom: "0.7rem", color: "#1d4ed8" }}>
            A saved review draft is available. Restore it to continue editing where you left off.
            Drafts expire automatically after 7 days.
          </div>
          <div className="operator-card__actions" style={{ marginTop: 0 }}>
            <button
              onClick={restoreSavedDraft}
              className="operator-button"
            >
              Restore draft
            </button>
            <button
              onClick={dismissSavedDraft}
              className="operator-button-secondary"
            >
              Dismiss
            </button>
          </div>
        </section>
      )}

      {activeJob && phase === "idle" && (
        <section className="operator-card operator-card--teal">
          <div className="operator-card__copy" style={{ marginBottom: "0.7rem", color: "#155e75" }}>
            A {activeJob.kind} run is still active on the server. Reconnect to resume the same live backlog claim.
          </div>
          <button
            onClick={() => {
              if (activeJob.kind === "research") {
                void startResearch(activeJob.jobId);
                return;
              }

              void writeToNotion(activeJob.jobId);
            }}
            className="operator-button"
          >
            Resume active run
          </button>
        </section>
      )}

      {phase === "idle" && (
        <div className="review-layout">
          <div className="operator-card operator-card--blue operator-grid">
            <label className="operator-checkbox" htmlFor="use-notion-queue-checkbox" style={{ color: "#1d4ed8" }}>
              <input
                id="use-notion-queue-checkbox"
                type="checkbox"
                checked={useNotionQueue}
                onChange={(event) => setUseNotionQueue(event.target.checked)}
              />
              <span>Use the Notion backlog claim loop (claim Ready → In Progress via MCP) instead of a blank prompt</span>
            </label>
            <div className="operator-card__copy" style={{ color: "#1e3a8a" }}>
              Default queue contract: <strong>{DEFAULT_NOTION_QUEUE_STATUS_PROPERTY} = {DEFAULT_NOTION_QUEUE_READY_VALUE}</strong> is
              claimed into <strong>In Progress</strong>, title from <strong>{DEFAULT_NOTION_QUEUE_TITLE_PROPERTY}</strong>,
              research text from <strong>{DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY}</strong>, then the claimed backlog row is
              advanced through <strong>Needs Review</strong> and <strong>Packet Ready</strong>.
            </div>
            {useNotionQueue && (
              <div className="operator-grid">
                {canUseLinkedWorkspaceActions ? (
                  <div className="linked-database-toolbar">
                    <button
                      onClick={() => {
                        void loadLinkedDatabases();
                      }}
                      disabled={isLinkedDatabasesLoading || isProcessing}
                      className="operator-button-secondary"
                      type="button"
                    >
                      {browseLinkedDatabasesLabel}
                    </button>
                    <button
                      onClick={() => {
                        void saveQueueBinding();
                      }}
                      disabled={isSaveQueueBindingDisabled}
                      className="operator-button-secondary"
                      type="button"
                    >
                      {saveQueueBindingLabel}
                    </button>
                    {linkedDatabases.length > 0 && (
                      <select
                        value={selectedLinkedDatabase ? selectedLinkedDatabase.databaseId : ""}
                        onChange={(event) => {
                          const database = linkedDatabases.find((entry) => entry.databaseId === event.target.value);

                          if (database) {
                            applyLinkedDatabase(database);
                          }
                        }}
                        className="operator-select linked-database-select"
                      >
                        <option value="">Choose a linked database</option>
                        {linkedDatabases.map((database) => (
                          <option key={database.databaseId} value={database.databaseId}>
                            {database.title}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : isLinkedWorkspaceStatusPending || isNotionOAuthStatusPending ? (
                  <div className="queue-preview-notice queue-preview-notice--info">
                    Checking Notion workspace status.
                  </div>
                ) : notionConnectionStatusError ? (
                  <div className="queue-preview-notice queue-preview-notice--error">
                    Could not load Notion connection status: {notionConnectionStatusError}
                  </div>
                ) : canStartNotionOAuth ? (
                  <div className="operator-card operator-card--blue" style={{ marginBottom: 0 }}>
                    <div className="operator-card__copy" style={{ color: "#1e3a8a" }}>
                      Connect a Notion workspace first, then linked database browsing and saved queue setup will appear here.
                    </div>
                    <div className="operator-card__actions" style={{ marginTop: "0.75rem" }}>
                      <a className="operator-button" href="/api/notion/connect">
                        Connect Notion workspace
                      </a>
                    </div>
                  </div>
                ) : (
                  <div className="operator-card operator-card--blue" style={{ marginBottom: 0 }}>
                    <div className="operator-card__copy" style={{ color: "#1e3a8a" }}>
                      Notion OAuth is not configured yet. Add the required env vars, then connect a workspace here.
                    </div>
                    {notionOAuthMissingEnvVarsLabel && (
                      <div className="queue-preview-notice queue-preview-notice--info" style={{ marginTop: "0.75rem" }}>
                        Missing: {notionOAuthMissingEnvVarsLabel}
                      </div>
                    )}
                  </div>
                )}
                {(linkedWorkspaceName || linkedDatabasesError || selectedLinkedDatabase) && (
                  <div className="linked-database-meta">
                    {linkedWorkspaceName && (
                      <div className="operator-card__copy" style={{ color: "#1e3a8a" }}>
                        Browsing databases from <strong>{linkedWorkspaceName}</strong>.
                      </div>
                    )}
                    {queueBindingMessage && (
                      <div className="queue-preview-notice queue-preview-notice--info">{queueBindingMessage}</div>
                    )}
                    {savedQueueBinding && (
                      <div className="operator-card__copy" style={{ color: "#1e3a8a" }}>
                        Saved queue binding updated {new Date(savedQueueBinding.updatedAt).toLocaleString()}.
                      </div>
                    )}
                    {linkedDatabasesError && (
                      <div className="queue-preview-notice queue-preview-notice--error">{linkedDatabasesError}</div>
                    )}
                    {selectedLinkedDatabase && (
                      <>
                        <div className="linked-database-summary">
                          <strong>{selectedLinkedDatabase.title}</strong>
                          <span>{selectedLinkedDatabase.databaseId}</span>
                        </div>
                        {selectedLinkedDatabase.description && (
                          <div className="operator-card__copy">{selectedLinkedDatabase.description}</div>
                        )}
                        <div className="linked-database-chips">
                          {selectedLinkedDatabase.properties.map((property) => (
                            <span
                              key={`${selectedLinkedDatabase.databaseId}-${property.name}`}
                              className="linked-database-chip"
                            >
                              {property.name} · {property.type}
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <input
                  value={notionQueueDatabaseId}
                  onChange={(event) => setNotionQueueDatabaseId(event.target.value)}
                  placeholder="Notion intake database ID"
                  className="operator-input"
                />
                <div className="operator-grid operator-grid--four">
                  <input
                    value={notionQueuePromptProperty}
                    onChange={(event) => setNotionQueuePromptProperty(event.target.value)}
                    placeholder={DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY}
                    className="operator-input"
                  />
                  <input
                    value={notionQueueTitleProperty}
                    onChange={(event) => setNotionQueueTitleProperty(event.target.value)}
                    placeholder={DEFAULT_NOTION_QUEUE_TITLE_PROPERTY}
                    className="operator-input"
                  />
                  <input
                    value={notionQueueStatusProperty}
                    onChange={(event) => setNotionQueueStatusProperty(event.target.value)}
                    placeholder={DEFAULT_NOTION_QUEUE_STATUS_PROPERTY}
                    className="operator-input"
                  />
                  <input
                    value={notionQueueReadyValue}
                    onChange={(event) => setNotionQueueReadyValue(event.target.value)}
                    placeholder={DEFAULT_NOTION_QUEUE_READY_VALUE}
                    className="operator-input"
                  />
                </div>
                <div className="operator-card__actions" style={{ marginTop: 0 }}>
                  <button
                    onClick={() => {
                      void loadQueuePreview();
                    }}
                    disabled={isInspectQueueDisabled}
                    className="operator-button-secondary"
                  >
                    {inspectQueueLabel}
                  </button>
                </div>
                {isQueuePreviewVisible && (
                  <div className="queue-preview-panel">
                    {queuePreviewError && (
                      <div className="queue-preview-notice queue-preview-notice--error">{queuePreviewError}</div>
                    )}
                    {queuePreview && (
                      <>
                        <div className="queue-preview-metrics">
                          <div className="queue-preview-stat">
                            <strong>{queuePreview.totalEntries}</strong>
                            <span>Total rows</span>
                          </div>
                          <div className="queue-preview-stat">
                            <strong>{queuePreview.readyEntries}</strong>
                            <span>Ready rows</span>
                          </div>
                          <div className="queue-preview-stat">
                            <strong>{queuePreview.readyWithUsablePromptEntries}</strong>
                            <span>Ready with usable prompt</span>
                          </div>
                          <div className="queue-preview-stat">
                            <strong>{queuePreview.usablePromptEntries}</strong>
                            <span>Usable prompts overall</span>
                          </div>
                        </div>
                        {missingQueueProperties.length > 0 && (
                          <div className="queue-preview-notice queue-preview-notice--warning">
                            Missing configured properties:{" "}
                            {missingQueueProperties.map((property) => property.name).join(", ")}
                          </div>
                        )}
                        <div className="queue-preview-statuses">
                          {queuePreview.statusCounts.map((statusEntry) => (
                            <span key={`${statusEntry.status}-${statusEntry.count}`} className="queue-preview-status-pill">
                              {statusEntry.status}: {statusEntry.count}
                            </span>
                          ))}
                        </div>
                        <div className="queue-preview-list">
                          {queuePreview.entries.map((entry) => (
                            <article key={entry.pageId} className={getQueuePreviewCardClassName(entry)}>
                              <div className="queue-preview-card__head">
                                <div>
                                  <div className="queue-preview-card__title">{entry.title || entry.pageId}</div>
                                  <div className="queue-preview-card__meta">{entry.pageId}</div>
                                </div>
                                <div className="queue-preview-card__badges">
                                  <span className="queue-preview-badge">{entry.status || "Unspecified"}</span>
                                  <span className="queue-preview-badge">{getQueuePromptSourceLabel(entry.promptSource)}</span>
                                </div>
                              </div>
                              <p className="queue-preview-card__prompt">
                                {entry.prompt || "This row has no usable prompt yet. Add prompt text or a usable title."}
                              </p>
                              <div className="queue-preview-card__foot">
                                <span>{entry.isReady ? "Matches Ready filter" : "Outside Ready filter"}</span>
                                <span>{entry.hasUsablePrompt ? "Runnable" : "Needs prompt cleanup"}</span>
                              </div>
                            </article>
                          ))}
                        </div>
                        {queuePreview.truncated && (
                          <div className="operator-card__copy" style={{ color: "#1e3a8a" }}>
                            Showing the first {queuePreview.entries.length} rows while counting all {queuePreview.totalEntries} rows in the queue.
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Fallback manual prompt if you are not pulling the next item from a Notion queue"
            rows={3}
            className="operator-textarea"
          />
          <div className="operator-card operator-grid" style={{ marginBottom: 0 }}>
            <label className="operator-label" htmlFor="research-mode-select">Research mode</label>
            <select
              id="research-mode-select"
              value={researchMode}
              onChange={(e) => setResearchMode(e.target.value === "deep" ? "deep" : "fast")}
              className="operator-select"
            >
              <option value="fast">Fast lane — default reviewed coverage</option>
              <option value="deep">Deep lane — higher evidence caps and diversity balancing</option>
            </select>
            <div className="operator-card__copy">
              The deep lane keeps the same reviewed write flow, but spends extra browse budget on domain diversity
              and source-class balancing before it concludes.
            </div>
          </div>
          <div className="operator-inline-list" style={{ marginTop: "0.75rem" }}>
            {EXAMPLE_PROMPTS.map((examplePrompt) => (
              <button
                key={examplePrompt}
                onClick={() => setPrompt(examplePrompt)}
                className="operator-chip"
              >
                {examplePrompt.slice(0, 40)}…
              </button>
            ))}
          </div>
            <button
              onClick={() => {
                void startResearch();
              }}
              disabled={!isStartActionEnabled}
              className="operator-button"
              style={{ marginTop: "1rem" }}
          >
              {useNotionQueue ? "Claim next Ready item" : "Process backlog item"}
            </button>
         </div>
       )}

      {activitySnapshot && (isProcessing || phase === "approving" || phase === "error" || phase === "done") && (
        <ActivityStatus
          title={activitySnapshot.title}
          detail={activitySnapshot.detail}
          stage={activitySnapshot.stage}
          percent={activitySnapshot.percent}
          kind={activitySnapshot.kind}
          elapsedSeconds={isProcessing ? elapsedSeconds : undefined}
          stats={activitySnapshot.stats}
        />
      )}

      {logs.length > 0 && (
        <div className="log-panel">
          {logs.map((log) => (
            <div
              key={log.id}
              className={`log-entry log-entry--${log.type}`}
            >
              {log.message}
            </div>
          ))}
          {isProcessing && (
            <div className="log-meta">
              ⏳ Working… {elapsedSeconds}s elapsed
            </div>
          )}
          {isProcessing && (
            <button
              onClick={cancelCurrentAction}
              aria-label="Cancel current operation"
              className="operator-button-ghost"
              style={{ marginTop: "0.75rem" }}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {phase === "approving" && editedResult && (
        <div className="review-layout">
          <h2 className="console-section-title" style={{ marginBottom: 0 }}>
            Review packet before write-back
          </h2>

          {isDegradedSearchMode && (
            <div className="operator-card operator-card--warning" style={{ marginBottom: 0 }}>
              This research run used degraded DuckDuckGo HTML fallback mode
              {searchProvidersUsed.length > 0 ? ` (${searchProvidersUsed.join(", ")})` : ""}. Review the source
              coverage carefully and configure <code>SERPER_API_KEY</code> or <code>BRAVE_SEARCH_API_KEY</code>{" "}
              to restore API-backed search.
            </div>
          )}

            <div className={`operator-card ${reviewedResearchMode === "deep" ? "operator-card--blue" : "operator-card--muted"}`} style={{ marginBottom: 0 }}>
            <strong>{reviewedResearchMode === "deep" ? "Deep lane mode" : "Fast research mode"}</strong>
            {reviewedResearchMode === "deep"
              ? reviewedProfile
                ? ` planned up to ${reviewedProfile.maxPlannedQueries} search queries, queued up to ${reviewedProfile.maxEvidenceDocuments} evidence documents, and required ${reviewedProfile.minSourceClasses} source classes before approval.`
                : " increased the evidence cap and balanced reviewed pages across domains and source classes before approval."
              : reviewedProfile
                ? ` kept the bounded reviewed lane at up to ${reviewedProfile.maxPlannedQueries} search queries and ${reviewedProfile.maxEvidenceDocuments} evidence documents so you can move quickly to operator review.`
                : " kept the default fast reviewed lane so you can move quickly to operator review."}{" "}
            {reviewedUniqueDomainCount > 0 && reviewedSourceClassCount > 0
              ? `This run covered ${reviewedUniqueDomainCount} domain${reviewedUniqueDomainCount === 1 ? "" : "s"} and ${reviewedSourceClassCount} source class${reviewedSourceClassCount === 1 ? "" : "es"}.`
              : reviewedUniqueDomainCount > 0
                ? `This run covered ${reviewedUniqueDomainCount} distinct domain${reviewedUniqueDomainCount === 1 ? "" : "s"}.`
                : ""}
          </div>

          {runMetadata?.notionQueue && (
            <div className="operator-card operator-card--green" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: "0.65rem" }}>Backlog item metadata</div>
              <div
                style={{
                  display: "grid",
                  gap: "0.5rem",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                }}
              >
                <div>
                  <strong>Backlog row</strong>
                  <br />
                  {runMetadata.notionQueue.title || runMetadata.notionQueue.pageId}
                </div>
                <div>
                  <strong>Current stage</strong>
                  <br />
                  Needs Review
                </div>
                <div>
                  <strong>Claimed by</strong>
                  <br />
                  {runMetadata.notionQueue.claimedBy}
                </div>
                <div>
                  <strong>Claimed at</strong>
                  <br />
                  {runMetadata.notionQueue.claimedAt
                    ? new Date(runMetadata.notionQueue.claimedAt).toLocaleString()
                    : "Not recorded"}
                </div>
                <div style={{ wordBreak: "break-all" }}>
                  <strong>Run ID</strong>
                  <br />
                  {runMetadata.notionQueue.runId}
                </div>
                <div>
                  <strong>Research mode</strong>
                  <br />
                  {reviewedResearchMode}
                </div>
                <div>
                  <strong>Source count</strong>
                  <br />
                  {reviewedSourceCount}
                </div>
                <div>
                  <strong>Rejected URLs</strong>
                  <br />
                  {reviewedRejectedUrlCount}
                </div>
              </div>
              <div style={{ marginTop: "0.65rem" }}>
                Ready → In Progress → <strong>Needs Review</strong> → Packet Ready. You approve before the same row is
                written back to Notion.
              </div>
            </div>
          )}

          <div className="operator-card operator-card--muted" style={{ marginBottom: 0 }}>
            <label className="operator-checkbox" htmlFor="use-existing-database-checkbox" style={{ color: "#333" }}>
              <input
                id="use-existing-database-checkbox"
                type="checkbox"
                checked={useExistingDatabase}
                onChange={(e) => setUseExistingDatabase(e.target.checked)}
              />
              <span>Add rows to an existing Notion database instead of creating a new one</span>
            </label>
            {useExistingDatabase && (
              <div style={{ marginTop: "0.75rem" }}>
                <label className="operator-label" htmlFor="existing-database-id-input">
                  Existing database ID
                </label>
                <input
                  id="existing-database-id-input"
                  value={targetDatabaseId}
                  onChange={(e) => setTargetDatabaseId(e.target.value)}
                  placeholder="e.g. 1a2b3c4d..."
                  className="operator-input"
                />
                <div className="operator-card__copy" style={{ marginTop: "0.4rem" }}>
                  Use either 32 hex characters without dashes or UUID format with dashes.
                </div>
              </div>
            )}
          </div>

          {!useExistingDatabase && (
            <div className="operator-card operator-card--blue" style={{ marginBottom: 0 }}>
              {canUseLinkedWorkspaceActions ? (
                <div className="linked-database-toolbar">
                  <button
                    onClick={() => {
                      void loadLinkedParents();
                    }}
                    disabled={isLinkedParentsLoading}
                    className="operator-button-secondary"
                    type="button"
                  >
                    {browseLinkedParentsLabel}
                  </button>
                  {linkedParents.length > 0 && (
                    <select
                      value={selectedLinkedParent ? selectedLinkedParent.pageId : ""}
                      onChange={(event) => setNotionParentPageId(event.target.value)}
                      className="operator-select linked-database-select"
                    >
                      <option value="">Choose a linked parent page</option>
                      {linkedParents.map((parent) => (
                        <option key={parent.pageId} value={parent.pageId}>
                          {parent.title}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ) : isLinkedWorkspaceStatusPending || isNotionOAuthStatusPending ? (
                <div className="queue-preview-notice queue-preview-notice--info">
                  Checking Notion workspace status.
                </div>
              ) : notionConnectionStatusError ? (
                <div className="queue-preview-notice queue-preview-notice--error">
                  Could not load Notion connection status: {notionConnectionStatusError}
                </div>
              ) : canStartNotionOAuth ? (
                <div className="operator-card__actions" style={{ marginTop: 0 }}>
                  <a className="operator-button" href="/api/notion/connect">
                    Connect Notion workspace
                  </a>
                </div>
              ) : (
                <div className="queue-preview-notice queue-preview-notice--info">
                  Configure Notion OAuth first{notionOAuthMissingEnvVarsLabel ? `: ${notionOAuthMissingEnvVarsLabel}` : "."}
                </div>
              )}
              {(linkedWorkspaceName || linkedParentsError || selectedLinkedParent) && (
                <div className="linked-database-meta" style={{ marginTop: "0.75rem" }}>
                  {linkedWorkspaceName && (
                    <div className="operator-card__copy" style={{ color: "#1e3a8a" }}>
                      Creating inside <strong>{linkedWorkspaceName}</strong> when a parent page is selected.
                    </div>
                  )}
                  {linkedParentsError && (
                    <div className="queue-preview-notice queue-preview-notice--error">{linkedParentsError}</div>
                  )}
                  {selectedLinkedParent && (
                    <>
                      <div className="linked-database-summary">
                        <strong>{selectedLinkedParent.title}</strong>
                        <span>{selectedLinkedParent.pageId}</span>
                      </div>
                      <div className="operator-card__copy">
                        {selectedLinkedParent.lastEditedTime
                          ? `Last edited ${new Date(selectedLinkedParent.lastEditedTime).toLocaleString()}.`
                          : "Linked parent page selected for new database creation."}
                      </div>
                    </>
                  )}
                </div>
              )}
              <div className="operator-card__copy" style={{ marginTop: "0.75rem" }}>
                {canUseLinkedWorkspaceActions
                  ? "Select a linked parent page to create the reviewed database inside the connected Notion workspace."
                  : "Connect a Notion workspace to choose where a new reviewed database should be created."}
              </div>
            </div>
          )}

          <div className="operator-card" style={{ marginBottom: 0 }}>
            <label className="operator-label" htmlFor="database-title-input">
              Database title
            </label>
            <input
              id="database-title-input"
              value={editedResult.suggestedDbTitle}
              onChange={(e) =>
                updateEditedResult((previous) => ({
                  ...previous,
                  suggestedDbTitle: e.target.value,
                }))
              }
              disabled={useExistingDatabase}
              title={
                useExistingDatabase
                  ? "The database title is only used when creating a new database."
                  : undefined
              }
              className="operator-input"
              style={{ background: useExistingDatabase ? "#f8f8f8" : undefined }}
            />
          </div>

          <div className="operator-card" style={{ marginBottom: 0 }}>
            <label className="operator-label" htmlFor="summary-textarea">
              Summary
            </label>
            <textarea
              id="summary-textarea"
              value={editedResult.summary}
              onChange={(e) => updateSummary(e.target.value)}
              rows={3}
              className="operator-textarea"
              style={{ background: "#f0f4ff" }}
            />
          </div>

          <div className="operator-card operator-card--blue" style={{ marginBottom: 0 }}>
            <h3 style={{ fontSize: "0.92rem", fontWeight: 600, margin: "0 0 0.35rem" }}>
              Android workflow
            </h3>
            <div>
              1. Write the results to Notion.
              <br />
              2. Use the final <code>https://www.notion.so/...</code> link.
              <br />
              3. On Android, either open that link directly or share/copy it into the Notion app.
            </div>
          </div>

          <div className="operator-grid">
            <SchemaEditor
              schemaEntries={schemaEntries}
              propertyTypes={PROPERTY_TYPES}
              historyIndex={historyIndex}
              historyLength={history.length}
              onUndo={undoEdit}
              onRedo={redoEdit}
              onAddColumn={addColumn}
              onRenameColumn={renameColumn}
              onUpdateColumnType={updateColumnType}
              onDeleteColumn={deleteColumn}
            />

            <RowEditor
              editedResult={editedResult}
              schemaEntries={schemaEntries}
              invalidCellLookup={invalidCellLookup}
              showFindReplace={showFindReplace}
              findText={findText}
              replaceText={replaceText}
              onToggleFindReplace={() => setShowFindReplace((current) => !current)}
              onFindTextChange={setFindText}
              onReplaceTextChange={setReplaceText}
              onReplaceAcrossRows={replaceAcrossRows}
              onExportJson={exportJson}
              onExportCsv={exportCsv}
              onUpdateItemValue={updateItemValue}
              onMoveItem={moveItem}
              onDuplicateItem={duplicateItem}
              onRemoveItem={removeItem}
            />
          </div>

          {pendingWriteResume && (
            <div className="operator-card operator-card--blue" style={{ marginBottom: 0 }}>
              Resume is ready from row {pendingWriteResume.nextRowIndex + 1} in Notion database{" "}
              <code>{pendingWriteResume.databaseId}</code>.
            </div>
          )}

          {approvalHint && (
            <div className="operator-card operator-card--warning" style={{ marginBottom: 0 }}>
              {approvalHint}
            </div>
          )}

          {validationIssues.length > 0 && (
            <div className="operator-card operator-card--warning" style={{ marginBottom: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>
                Fix these issues before writing to Notion:
              </div>
              <ul style={{ margin: 0, paddingLeft: "1rem" }}>
                {validationIssues.slice(0, 5).map((issue) => (
                  <li key={`${issue.rowIndex}-${issue.columnName}-${issue.message}`}>
                    {issue.message}
                  </li>
                ))}
              </ul>
              {validationIssues.length > 5 && (
                <div style={{ marginTop: "0.35rem" }}>
                  And {validationIssues.length - 5} more issue(s) in highlighted cells.
                </div>
              )}
            </div>
          )}

          <div className="review-actions">
            <button
              onClick={() => {
                void writeToNotion();
              }}
              disabled={!canWrite}
              aria-disabled={!canWrite}
              title={!canWrite ? approvalHint ?? "Complete the review before write-back to Notion." : undefined}
              className="operator-button"
            >
              {pendingWriteResume ? "Resume write-back" : "Write back to Notion"} ({editedResult.items.length} rows)
            </button>
            <button
              onClick={reset}
              className="operator-button-secondary"
            >
              {useNotionQueue ? "Claim a different item" : "Reset packet"}
            </button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <CompletionPanel
          notionUrl={notionUrl}
          writeSummary={writeSummary}
          linkActionMessage={linkActionMessage}
          canShare={typeof navigator !== "undefined" && typeof navigator.share === "function"}
          onShare={() => {
            void shareNotionLink();
          }}
          onCopy={() => {
            void copyNotionLink();
          }}
          onReset={reset}
        />
      )}

      {phase === "error" && (
        <div className="review-layout">
          {errorMessage && (
            <div className="operator-card operator-card--error" style={{ marginBottom: 0 }}>
              {errorMessage}
            </div>
          )}
          {pendingWriteResume && (
            <div className="operator-card operator-card--blue" style={{ marginBottom: 0 }}>
              Retry last step will resume from row {pendingWriteResume.nextRowIndex + 1} in
              Notion database <code>{pendingWriteResume.databaseId}</code>.
            </div>
          )}
          <div className="review-actions">
            <button
              onClick={retryLastAction}
              disabled={!lastActionRef.current}
              aria-disabled={!lastActionRef.current}
              title={
                !lastActionRef.current
                  ? "Retry becomes available after a failed research or write step."
                  : undefined
              }
              className="operator-button"
            >
              {pendingWriteResume ? "Resume write-back" : "Retry last step"}
            </button>
            <button
              onClick={reset}
              className="operator-button-secondary"
            >
              {useNotionQueue ? "Claim a different item" : "Reset packet"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

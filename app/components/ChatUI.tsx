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
  const abortRef = useRef<AbortController | null>(null);
  const currentWriteJobIdRef = useRef<string | null>(null);
  const historyIndexRef = useRef(-1);
  const timeoutWarningLoggedRef = useRef(false);
  const autoResumeAttemptedRef = useRef(false);
  const startResearchRef = useRef<(jobId?: string) => Promise<void>>(async () => undefined);
  const writeToNotionRef = useRef<(jobId?: string) => Promise<void>>(async () => undefined);

  const { savedDraft, clearSavedDraft, draftPersistenceNotice, draftPersistenceNoticeTone } = useDraftPersistence({
    phase,
    prompt,
    editedResult,
    useExistingDatabase,
    targetDatabaseId,
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
  const isStartActionEnabled = Boolean(
    prompt.trim() || (useNotionQueue && notionQueueDatabaseId.trim())
  );

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { type, message }]);
  };

  const clearActiveJobState = () => {
    clearActiveJob(window.localStorage);
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
    saveActiveJob(window.localStorage, nextJob);
    setActiveJob(nextJob);

    if (kind === "write") {
      currentWriteJobIdRef.current = jobId;
    }
  };

  const initializeHistory = (result: EditableResult) => {
    setHistory([result]);
    setHistoryIndex(0);
    historyIndexRef.current = 0;
  };

  useEffect(() => {
    const persistedPreference = window.localStorage.getItem(DRAFT_PERSISTENCE_PREFERENCE_KEY);

    if (persistedPreference === "true") {
      setPersistDrafts(true);
    }

    setActiveJob(loadActiveJob(window.localStorage));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(DRAFT_PERSISTENCE_PREFERENCE_KEY, persistDrafts ? "true" : "false");
  }, [persistDrafts]);

  useEffect(() => {
    if (phase === "researching" || phase === "writing") {
      setElapsedSeconds(0);
      timeoutWarningLoggedRef.current = false;

      const startedAt = Date.now();
      const interval = window.setInterval(() => {
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

      return () => window.clearInterval(interval);
    }

    setElapsedSeconds(0);
  }, [phase]);

  useEffect(() => {
    if (!editedResult || !["approving", "error"].includes(phase)) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
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
        onUpdate: (msg) => addLog(msg),
        onEvent: (event, data) => handleJobEvent("research", event, data),
      })) as ResearchResult;

      const nextResult = {
        ...data,
        schema: data.schema as Record<string, PropertyType>,
      };
      setEditedResult(nextResult);
      initializeHistory(nextResult);
      clearActiveJobState();
      addLog(`✅ Research complete — found ${data.items.length} items`, "success");
      showApproval();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        addLog("Research cancelled.", "info");
        clearActiveJobState();
        setPhase("idle");
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      clearActiveJobState();
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
        : (editedResult as EditableResult);

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

      const controller = new AbortController();
      abortRef.current = controller;
      const data = (await streamSSE({
        url: "/api/write",
        body: jobId ? { jobId } : payload,
        signal: controller.signal,
        accessToken: appAccessToken,
        onUpdate: (msg) => addLog(msg),
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
        showApproval();
        return;
      }

      const details =
        err instanceof Error && "details" in err
          ? (err as Error & { details?: StreamErrorPayload }).details
          : undefined;
      const message = err instanceof Error ? err.message : String(err);
      clearActiveJobState();
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
    window.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_CLEANUP_DELAY_MS);
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
        : editedResult;

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
        title: "Open in Notion",
        text: "Open this Notion database",
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
      currentWriteJobIdRef.current = null;
      clearSavedDraft();
    };

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "2rem 1rem", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          🔍 Notion MCP Backlog Desk
        </h1>
        <p style={{ color: "#666", marginTop: "0.5rem", fontSize: "0.9rem" }}>
          Ready Item → Reviewed Packet: claim the next backlog row, research it, review it, and write the approved packet back into Notion
        </p>
      </div>

      <div
        style={{
          marginBottom: "1rem",
          padding: "0.9rem 1rem",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
        }}
      >
        <div style={{ fontSize: "0.92rem", fontWeight: 600, color: "#0f172a", marginBottom: "0.35rem" }}>
          Local-first access
        </div>
        <div style={{ fontSize: "0.84rem", color: "#475569", marginBottom: "0.65rem", lineHeight: 1.5 }}>
          Localhost requests work without extra headers. If you intentionally run this UI against a
          private remote deployment, enter the matching <code>APP_ACCESS_TOKEN</code> so the browser
          can send the required <code>x-app-access-token</code> header.
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.82rem",
            color: "#475569",
            marginBottom: "0.65rem",
          }}
        >
          <input
            type="checkbox"
            checked={persistDrafts}
            onChange={(e) => setPersistDrafts(e.target.checked)}
          />
          Enable local draft persistence on this trusted browser for up to 7 days
        </label>
        <label style={{ fontSize: "0.82rem", color: "#475569", display: "block", marginBottom: "0.3rem" }}>
          App access token (optional)
        </label>
        <input
          type="password"
          value={appAccessToken}
          onChange={(e) => setAppAccessToken(e.target.value)}
          placeholder="Only needed for a tightly controlled remote deployment"
          autoComplete="off"
          style={{
            width: "100%",
            padding: "0.6rem 0.75rem",
            border: "1px solid #cbd5e1",
            borderRadius: 8,
            boxSizing: "border-box",
          }}
        />
        {draftPersistenceNotice && (
          <div
            style={{
              marginTop: "0.65rem",
              padding: "0.65rem 0.75rem",
              background:
                draftPersistenceNoticeTone === "success"
                  ? "#fff7ed"
                  : draftPersistenceNoticeTone === "privacy"
                    ? "#eff6ff"
                    : "#fef2f2",
              border: `1px solid ${
                draftPersistenceNoticeTone === "success"
                  ? "#fed7aa"
                  : draftPersistenceNoticeTone === "privacy"
                    ? "#bfdbfe"
                    : "#fecaca"
              }`,
              borderRadius: 8,
              color:
                draftPersistenceNoticeTone === "success"
                  ? "#9a3412"
                  : draftPersistenceNoticeTone === "privacy"
                    ? "#1d4ed8"
                    : "#b91c1c",
              fontSize: "0.8rem",
              lineHeight: 1.45,
            }}
          >
            {draftPersistenceNotice}
          </div>
        )}
      </div>

      {savedDraft && phase === "idle" && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.9rem 1rem",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: "0.9rem", color: "#1d4ed8", marginBottom: "0.6rem" }}>
            A saved review draft is available. Restore it to continue editing where you left off.
            Drafts expire automatically after 7 days.
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              onClick={restoreSavedDraft}
              style={{
                padding: "0.55rem 0.9rem",
                border: "none",
                borderRadius: 8,
                background: "#1d4ed8",
                color: "#fff",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              Restore draft
            </button>
            <button
              onClick={dismissSavedDraft}
              style={{
                padding: "0.55rem 0.9rem",
                border: "1px solid #bfdbfe",
                borderRadius: 8,
                background: "#fff",
                color: "#1d4ed8",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {activeJob && phase === "idle" && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.9rem 1rem",
            background: "#ecfeff",
            border: "1px solid #a5f3fc",
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: "0.9rem", color: "#155e75", marginBottom: "0.6rem" }}>
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
            style={{
              padding: "0.55rem 0.9rem",
              border: "none",
              borderRadius: 8,
              background: "#0f766e",
              color: "#fff",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            Resume active run
          </button>
        </div>
      )}

      {phase === "idle" && (
        <div>
          <div
            style={{
              marginBottom: "0.75rem",
              display: "grid",
              gap: "0.5rem",
              padding: "0.85rem 0.95rem",
              border: "1px solid #dbeafe",
              borderRadius: 8,
              background: "#eff6ff",
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#1d4ed8", fontSize: "0.88rem" }}>
              <input
                type="checkbox"
                checked={useNotionQueue}
                onChange={(event) => setUseNotionQueue(event.target.checked)}
              />
              Use the Notion backlog claim loop (claim Ready → In Progress via MCP) instead of a blank prompt
            </label>
            <div style={{ fontSize: "0.8rem", color: "#1e3a8a", lineHeight: 1.45 }}>
              Default queue contract: <strong>{DEFAULT_NOTION_QUEUE_STATUS_PROPERTY}</strong>=
              <strong>{DEFAULT_NOTION_QUEUE_READY_VALUE}</strong> is claimed into <strong>In Progress</strong>, title from{" "}
              <strong>{DEFAULT_NOTION_QUEUE_TITLE_PROPERTY}</strong>, research text from{" "}
              <strong>{DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY}</strong>, then the original row is enriched through{" "}
              <strong>Needs Review</strong> and <strong>Packet Ready</strong>.
            </div>
            {useNotionQueue && (
              <div style={{ display: "grid", gap: "0.5rem" }}>
                <input
                  value={notionQueueDatabaseId}
                  onChange={(event) => setNotionQueueDatabaseId(event.target.value)}
                  placeholder="Notion intake database ID"
                  style={{
                    width: "100%",
                    padding: "0.65rem 0.75rem",
                    border: "1px solid #bfdbfe",
                    borderRadius: 8,
                    fontSize: "0.9rem",
                    boxSizing: "border-box",
                    background: "#fff",
                  }}
                />
                <div style={{ display: "grid", gap: "0.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
                  <input
                    value={notionQueuePromptProperty}
                    onChange={(event) => setNotionQueuePromptProperty(event.target.value)}
                    placeholder={DEFAULT_NOTION_QUEUE_PROMPT_PROPERTY}
                    style={{
                      width: "100%",
                      padding: "0.6rem 0.7rem",
                      border: "1px solid #bfdbfe",
                      borderRadius: 8,
                      fontSize: "0.85rem",
                      boxSizing: "border-box",
                      background: "#fff",
                    }}
                  />
                  <input
                    value={notionQueueTitleProperty}
                    onChange={(event) => setNotionQueueTitleProperty(event.target.value)}
                    placeholder={DEFAULT_NOTION_QUEUE_TITLE_PROPERTY}
                    style={{
                      width: "100%",
                      padding: "0.6rem 0.7rem",
                      border: "1px solid #bfdbfe",
                      borderRadius: 8,
                      fontSize: "0.85rem",
                      boxSizing: "border-box",
                      background: "#fff",
                    }}
                  />
                  <input
                    value={notionQueueStatusProperty}
                    onChange={(event) => setNotionQueueStatusProperty(event.target.value)}
                    placeholder={DEFAULT_NOTION_QUEUE_STATUS_PROPERTY}
                    style={{
                      width: "100%",
                      padding: "0.6rem 0.7rem",
                      border: "1px solid #bfdbfe",
                      borderRadius: 8,
                      fontSize: "0.85rem",
                      boxSizing: "border-box",
                      background: "#fff",
                    }}
                  />
                  <input
                    value={notionQueueReadyValue}
                    onChange={(event) => setNotionQueueReadyValue(event.target.value)}
                    placeholder={DEFAULT_NOTION_QUEUE_READY_VALUE}
                    style={{
                      width: "100%",
                      padding: "0.6rem 0.7rem",
                      border: "1px solid #bfdbfe",
                      borderRadius: 8,
                      fontSize: "0.85rem",
                      boxSizing: "border-box",
                      background: "#fff",
                    }}
                  />
                </div>
              </div>
            )}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Fallback manual prompt if you are not pulling the next item from a Notion queue"
            rows={3}
            style={{
              width: "100%",
              padding: "0.75rem",
              border: "1px solid #ddd",
              borderRadius: 8,
              fontSize: "0.95rem",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div
            style={{
              marginTop: "0.75rem",
              display: "grid",
              gap: "0.35rem",
              padding: "0.75rem 0.9rem",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              background: "#fafafa",
            }}
          >
            <label style={{ fontSize: "0.85rem", color: "#111827", fontWeight: 600 }}>Research mode</label>
            <select
              value={researchMode}
              onChange={(e) => setResearchMode(e.target.value === "deep" ? "deep" : "fast")}
              style={{
                width: "100%",
                padding: "0.55rem 0.7rem",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                fontSize: "0.9rem",
                background: "#fff",
              }}
            >
              <option value="fast">Fast lane — default reviewed coverage</option>
              <option value="deep">Deep lane — higher evidence caps and diversity balancing</option>
            </select>
            <div style={{ fontSize: "0.8rem", color: "#4b5563", lineHeight: 1.45 }}>
              The deep lane keeps the same reviewed write flow, but spends extra browse budget on domain diversity
              and source-class balancing before it concludes.
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
            {EXAMPLE_PROMPTS.map((examplePrompt) => (
              <button
                key={examplePrompt}
                onClick={() => setPrompt(examplePrompt)}
                style={{
                  padding: "0.3rem 0.75rem",
                  border: "1px solid #ddd",
                  borderRadius: 20,
                  background: "none",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  color: "#555",
                }}
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
              style={{
                marginTop: "1rem",
                padding: "0.75rem 1.5rem",
                background: isStartActionEnabled ? "#000" : "#ccc",
                color: "#fff",
                border: "none",
               borderRadius: 8,
               cursor: isStartActionEnabled ? "pointer" : "default",
               fontSize: "0.95rem",
               fontWeight: 500,
             }}
           >
             {useNotionQueue ? "Process next ready item" : "Start research"}
           </button>
        </div>
      )}

      {logs.length > 0 && (
        <div
          style={{
            marginTop: "1.5rem",
            background: "#f8f8f8",
            borderRadius: 8,
            padding: "1rem",
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {logs.map((log, index) => (
            <div
              key={index}
              style={{
                fontSize: "0.85rem",
                padding: "0.2rem 0",
                color: log.type === "error" ? "#c00" : log.type === "success" ? "#080" : "#333",
              }}
            >
              {log.message}
            </div>
          ))}
          {(phase === "researching" || phase === "writing") && (
            <div style={{ fontSize: "0.85rem", color: "#999", marginTop: "0.25rem" }}>
              ⏳ Working… {elapsedSeconds}s elapsed
            </div>
          )}
          {(phase === "researching" || phase === "writing") && (
            <button
              onClick={cancelCurrentAction}
              aria-label="Cancel current operation"
              style={{
                marginTop: "0.75rem",
                padding: "0.45rem 0.8rem",
                background: "none",
                border: "1px solid #ddd",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: "0.8rem",
                color: "#555",
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {phase === "approving" && editedResult && (
        <div style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Review before writing to Notion
          </h2>

          {isDegradedSearchMode && (
            <div
              style={{
                marginBottom: "1rem",
                padding: "0.75rem 0.9rem",
                background: "#fff7ed",
                border: "1px solid #fdba74",
                borderRadius: 8,
                color: "#9a3412",
                fontSize: "0.85rem",
                lineHeight: 1.45,
              }}
            >
              This research run used degraded DuckDuckGo HTML fallback mode
              {searchProvidersUsed.length > 0 ? ` (${searchProvidersUsed.join(", ")})` : ""}. Review the source
              coverage carefully and configure <code>SERPER_API_KEY</code> or <code>BRAVE_SEARCH_API_KEY</code>{" "}
              to restore API-backed search.
            </div>
          )}

          <div
            style={{
              marginBottom: "1rem",
              padding: "0.75rem 0.9rem",
              background: reviewedResearchMode === "deep" ? "#eff6ff" : "#f8fafc",
              border: `1px solid ${reviewedResearchMode === "deep" ? "#bfdbfe" : "#e2e8f0"}`,
              borderRadius: 8,
              color: reviewedResearchMode === "deep" ? "#1d4ed8" : "#334155",
              fontSize: "0.85rem",
              lineHeight: 1.45,
            }}
          >
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
            <div
              style={{
                marginBottom: "1rem",
                padding: "0.75rem 0.9rem",
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: 8,
                color: "#166534",
                fontSize: "0.85rem",
                lineHeight: 1.45,
              }}
            >
              <strong>Backlog lifecycle</strong> claimed{" "}
              <strong>{runMetadata.notionQueue.title || runMetadata.notionQueue.pageId}</strong> from Notion as{" "}
              <strong>In Progress</strong>
              {runMetadata.notionQueue.claimedAt
                ? ` at ${new Date(runMetadata.notionQueue.claimedAt).toLocaleString()}`
                : ""}
              . After your review, the same row will advance through <strong>Needs Review</strong> and{" "}
              <strong>Packet Ready</strong>. Claim owner: <strong>{runMetadata.notionQueue.claimedBy}</strong>.
            </div>
          )}

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem", color: "#333" }}>
              <input
                type="checkbox"
                checked={useExistingDatabase}
                onChange={(e) => setUseExistingDatabase(e.target.checked)}
              />
              Add rows to an existing Notion database instead of creating a new one
            </label>
            {useExistingDatabase && (
              <div style={{ marginTop: "0.75rem" }}>
                <label style={{ fontSize: "0.85rem", color: "#555", display: "block", marginBottom: "0.3rem" }}>
                  Existing database ID
                </label>
                <input
                  value={targetDatabaseId}
                  onChange={(e) => setTargetDatabaseId(e.target.value)}
                  placeholder="e.g. 1a2b3c4d..."
                  style={{
                    padding: "0.5rem",
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                />
                <div style={{ marginTop: "0.35rem", fontSize: "0.8rem", color: "#666" }}>
                  Use either 32 hex characters without dashes or UUID format with dashes.
                </div>
              </div>
            )}
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ fontSize: "0.85rem", color: "#555", display: "block", marginBottom: "0.3rem" }}>
              Database title
            </label>
            <input
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
              style={{
                padding: "0.5rem",
                border: "1px solid #ddd",
                borderRadius: 6,
                width: "100%",
                boxSizing: "border-box",
                background: useExistingDatabase ? "#f8f8f8" : "#fff",
              }}
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ fontSize: "0.85rem", color: "#555", display: "block", marginBottom: "0.3rem" }}>
              Summary
            </label>
            <textarea
              value={editedResult.summary}
              onChange={(e) => updateSummary(e.target.value)}
              rows={3}
              style={{
                width: "100%",
                padding: "0.75rem 1rem",
                background: "#f0f4ff",
                border: "1px solid #dbeafe",
                borderRadius: 8,
                fontSize: "0.9rem",
                color: "#333",
                boxSizing: "border-box",
                resize: "vertical",
              }}
            />
          </div>

          <div
            style={{
              marginBottom: "1rem",
              padding: "0.75rem 0.9rem",
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: 8,
              color: "#1d4ed8",
              fontSize: "0.85rem",
            }}
          >
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

          <div style={{ marginBottom: "1rem" }}>
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
            <div
              style={{
                marginBottom: "0.75rem",
                padding: "0.75rem 1rem",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 8,
                color: "#1d4ed8",
                fontSize: "0.85rem",
              }}
            >
              Resume is ready from row {pendingWriteResume.nextRowIndex + 1} in Notion database{" "}
              <code>{pendingWriteResume.databaseId}</code>.
            </div>
          )}

          {approvalHint && (
            <div
              style={{
                marginBottom: "0.75rem",
                padding: "0.75rem 1rem",
                background: "#fff7ed",
                border: "1px solid #fdba74",
                borderRadius: 8,
                color: "#9a3412",
                fontSize: "0.85rem",
              }}
            >
              {approvalHint}
            </div>
          )}

          {validationIssues.length > 0 && (
            <div
              style={{
                marginBottom: "0.75rem",
                padding: "0.75rem 1rem",
                background: "#fff7ed",
                border: "1px solid #fdba74",
                borderRadius: 8,
                color: "#9a3412",
                fontSize: "0.85rem",
              }}
            >
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

          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              onClick={() => {
                void writeToNotion();
              }}
              disabled={!canWrite}
              aria-disabled={!canWrite}
              title={!canWrite ? approvalHint ?? "Complete the review before writing to Notion." : undefined}
              style={{
                padding: "0.75rem 1.5rem",
                background: canWrite ? "#000" : "#ccc",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: canWrite ? "pointer" : "default",
                fontSize: "0.95rem",
                fontWeight: 500,
              }}
            >
              {pendingWriteResume ? "Resume write" : useExistingDatabase ? "➕ Add to Notion" : "✍️ Write to Notion"} ({editedResult.items.length} rows)
            </button>
            <button
              onClick={reset}
              style={{
                padding: "0.75rem 1rem",
                background: "none",
                border: "1px solid #ddd",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: "0.95rem",
                color: "#555",
              }}
            >
              Start over
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
        <div style={{ marginTop: "1rem" }}>
          {errorMessage && (
            <div
              style={{
                marginBottom: "0.75rem",
                padding: "0.85rem 1rem",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: 8,
                color: "#b42318",
                fontSize: "0.9rem",
              }}
            >
              {errorMessage}
            </div>
          )}
          {pendingWriteResume && (
            <div
              style={{
                marginBottom: "0.75rem",
                padding: "0.85rem 1rem",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 8,
                color: "#1d4ed8",
                fontSize: "0.9rem",
              }}
            >
              Retry last step will resume from row {pendingWriteResume.nextRowIndex + 1} in
              Notion database <code>{pendingWriteResume.databaseId}</code>.
            </div>
          )}
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              onClick={retryLastAction}
              disabled={!lastActionRef.current}
              aria-disabled={!lastActionRef.current}
              title={
                !lastActionRef.current
                  ? "Retry becomes available after a failed research or write step."
                  : undefined
              }
              style={{
                padding: "0.6rem 1.25rem",
                background: lastActionRef.current ? "#000" : "#ccc",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: lastActionRef.current ? "pointer" : "default",
                fontSize: "0.9rem",
              }}
            >
              {pendingWriteResume ? "Resume write" : "Retry last step"}
            </button>
            <button
              onClick={reset}
              style={{
                padding: "0.6rem 1.25rem",
                background: "none",
                border: "1px solid #ddd",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: "0.9rem",
              }}
            >
              Start over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

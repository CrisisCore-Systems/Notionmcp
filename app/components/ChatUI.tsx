"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ResearchResult } from "@/lib/agent";

type Phase = "idle" | "researching" | "approving" | "writing" | "done" | "error";
type PropertyType = "title" | "rich_text" | "url" | "number" | "select";
type EditableResult = ResearchResult & {
  schema: Record<string, PropertyType>;
};
type WritePayload = EditableResult & { targetDatabaseId?: string };
type StoredDraft = {
  prompt: string;
  editedResult: EditableResult;
  useExistingDatabase: boolean;
  targetDatabaseId: string;
};
type ValidationIssue = {
  rowIndex: number;
  columnName: string;
  message: string;
};
type WriteSummary = {
  databaseId: string;
  itemsWritten: number;
  propertyCount: number;
  usedExistingDatabase: boolean;
};

interface LogEntry {
  type: "info" | "success" | "error";
  message: string;
}

const EXAMPLE_PROMPTS = [
  "Find the top 5 competitors to Notion in the productivity space",
  "Research the best free open-source React component libraries",
  "Find recent AI research papers on reasoning and tool use",
  "List the top venture capital firms focused on AI startups",
];

const PROPERTY_TYPES: PropertyType[] = ["title", "rich_text", "url", "number", "select"];
const BLOB_URL_CLEANUP_DELAY_MS = 5000;
const DRAFT_STORAGE_KEY = "notion-research-agent-draft";
const ACTION_TIMEOUT_WARNING_SECONDS = 100;

function formatPropertyTypeLabel(type: PropertyType): string {
  return type
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getSafeFilename(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[^a-z0-9_ -]/gi, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();

  return sanitized || fallback;
}

function getUniqueColumnName(
  requestedName: string,
  schema: Record<string, PropertyType>,
  excludeName?: string
): string {
  const trimmed = requestedName.trim() || "New Field";
  const lowerExcluded = excludeName?.toLowerCase();

  if (
    !Object.keys(schema).some(
      (key) => key.toLowerCase() === trimmed.toLowerCase() && key.toLowerCase() !== lowerExcluded
    )
  ) {
    return trimmed;
  }

  let suffix = 2;
  let candidate = `${trimmed} ${suffix}`;

  while (
    Object.keys(schema).some(
      (key) => key.toLowerCase() === candidate.toLowerCase() && key.toLowerCase() !== lowerExcluded
    )
  ) {
    suffix += 1;
    candidate = `${trimmed} ${suffix}`;
  }

  return candidate;
}

function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, item);
  return nextItems;
}

function escapeCsvValue(value: string): string {
  if (value.includes("\"") || /[,\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function buildCsv(result: EditableResult): string {
  const columns = Object.keys(result.schema);
  const header = columns.map(escapeCsvValue).join(",");
  const rows = result.items.map((item) =>
    columns.map((column) => escapeCsvValue(item[column] ?? "")).join(",")
  );

  return [header, ...rows].join("\n");
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getValidationIssues(result: EditableResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const titleColumn = Object.entries(result.schema).find(([, type]) => type === "title")?.[0];

  result.items.forEach((item, rowIndex) => {
    if (titleColumn && !item[titleColumn]?.trim()) {
      issues.push({
        rowIndex,
        columnName: titleColumn,
        message: `Row ${rowIndex + 1} is missing a title value.`,
      });
    }

    for (const [columnName, propertyType] of Object.entries(result.schema)) {
      const value = item[columnName]?.trim() ?? "";

      if (!value) continue;

      if (propertyType === "url" && !isValidHttpUrl(value)) {
        issues.push({
          rowIndex,
          columnName,
          message: `Row ${rowIndex + 1} has an invalid URL in "${columnName}".`,
        });
      }

      if (propertyType === "number" && !Number.isFinite(Number(value))) {
        issues.push({
          rowIndex,
          columnName,
          message: `Row ${rowIndex + 1} has a non-numeric value in "${columnName}".`,
        });
      }
    }
  });

  return issues;
}

export default function ChatUI() {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [editedResult, setEditedResult] = useState<EditableResult | null>(null);
  const [history, setHistory] = useState<EditableResult[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [notionUrl, setNotionUrl] = useState<string | null>(null);
  const [writeSummary, setWriteSummary] = useState<WriteSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [useExistingDatabase, setUseExistingDatabase] = useState(false);
  const [targetDatabaseId, setTargetDatabaseId] = useState("");
  const [savedDraft, setSavedDraft] = useState<StoredDraft | null>(null);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const historyIndexRef = useRef(-1);
  const lastActionRef = useRef<"research" | "write" | null>(null);
  const timeoutWarningLoggedRef = useRef(false);

  const schemaEntries = editedResult
    ? (Object.entries(editedResult.schema) as [string, PropertyType][])
    : [];
  const titleFieldCount = schemaEntries.filter(([, type]) => type === "title").length;
  const hasSchema = schemaEntries.length > 0;
  const targetDatabaseValid = !useExistingDatabase || !!targetDatabaseId.trim();
  const validationIssues = useMemo(
    () => (editedResult ? getValidationIssues(editedResult) : []),
    [editedResult]
  );
  const invalidCellLookup = useMemo(() => {
    const lookup = new Set<string>();

    for (const issue of validationIssues) {
      lookup.add(`${issue.rowIndex}:${issue.columnName}`);
    }

    return lookup;
  }, [validationIssues]);
  const canWrite =
    !!editedResult &&
    editedResult.items.length > 0 &&
    hasSchema &&
    titleFieldCount === 1 &&
    !!editedResult.suggestedDbTitle.trim() &&
    !!editedResult.summary.trim() &&
    targetDatabaseValid &&
    validationIssues.length === 0;

  let approvalHint: string | null = null;
  if (editedResult) {
    if (titleFieldCount !== 1) {
      approvalHint = "Your schema must contain exactly one title field before writing to Notion.";
    } else if (!targetDatabaseValid) {
      approvalHint = "Enter an existing Notion database ID or switch back to creating a new database.";
    } else if (validationIssues.length > 0) {
      approvalHint = validationIssues[0]?.message ?? "Fix the highlighted cells before writing to Notion.";
    } else if (!editedResult.summary.trim()) {
      approvalHint = "Add a summary before writing to Notion.";
    } else if (!editedResult.suggestedDbTitle.trim()) {
      approvalHint = "Add a database title before writing to Notion.";
    }
  }

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { type, message }]);
  };

  const initializeHistory = (result: EditableResult) => {
    setHistory([result]);
    setHistoryIndex(0);
    historyIndexRef.current = 0;
  };

  useEffect(() => {
    try {
      const rawDraft = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!rawDraft) return;

      setSavedDraft(JSON.parse(rawDraft) as StoredDraft);
    } catch {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (phase === "researching" || phase === "writing") {
      setElapsedSeconds(0);
      timeoutWarningLoggedRef.current = false;

      const startedAt = Date.now();
      const interval = window.setInterval(() => {
        const nextElapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        setElapsedSeconds(nextElapsedSeconds);

        if (
          nextElapsedSeconds >= ACTION_TIMEOUT_WARNING_SECONDS &&
          !timeoutWarningLoggedRef.current
        ) {
          addLog(
            "⏱️ This request is nearing the 120 second timeout limit. You can cancel and retry if it stalls.",
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
    if (!editedResult || !["approving", "error"].includes(phase)) return;

    const draft: StoredDraft = {
      prompt,
      editedResult,
      useExistingDatabase,
      targetDatabaseId,
    };

    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    setSavedDraft(draft);
  }, [editedResult, phase, prompt, targetDatabaseId, useExistingDatabase]);

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
    setNotionUrl(null);
    setWriteSummary(null);
    setErrorMessage(null);
    setPhase("approving");
    addLog("Restored your saved draft.", "success");
  };

  const dismissSavedDraft = () => {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    setSavedDraft(null);
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

  const streamSSE = async (
    url: string,
    body: unknown,
    onUpdate: (msg: string) => void
  ): Promise<unknown> => {
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        let message = text || `Request failed with status ${res.status}`;

        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          // Fall back to the raw response text when the error body is not JSON.
        }

        throw new Error(message);
      }

      if (!res.body) {
        throw new Error("Streaming response was empty.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let event = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            event = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (event === "update") onUpdate(data.message);
            else if (event === "complete") return data;
            else if (event === "error") throw new Error(data.message);
          }
        }
      }

      throw new Error(
        "Streaming response ended unexpectedly before completion. Please try again."
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  const startResearch = async () => {
    if (!prompt.trim()) return;
    lastActionRef.current = "research";
    setPhase("researching");
    setLogs([]);
    setEditedResult(null);
    setHistory([]);
    setHistoryIndex(-1);
    historyIndexRef.current = -1;
    setNotionUrl(null);
    setWriteSummary(null);
    setErrorMessage(null);

    try {
      addLog(`Starting research: "${prompt}"`, "info");

      const data = (await streamSSE(
        "/api/research",
        { prompt },
        (msg) => addLog(msg)
      )) as ResearchResult;

      const nextResult = {
        ...data,
        schema: data.schema as Record<string, PropertyType>,
      };
      setEditedResult(nextResult);
      initializeHistory(nextResult);
      addLog(`✅ Research complete — found ${data.items.length} items`, "success");
      setPhase("approving");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        addLog("Research cancelled.", "info");
        setPhase("idle");
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      addLog(`Error: ${message}`, "error");
      setPhase("error");
    }
  };

  const writeToNotion = async () => {
    if (!editedResult || !canWrite) return;
    lastActionRef.current = "write";
    setPhase("writing");
    setErrorMessage(null);
    setWriteSummary(null);

    const payload: WritePayload = useExistingDatabase && targetDatabaseId.trim()
      ? { ...editedResult, targetDatabaseId: targetDatabaseId.trim() }
      : editedResult;

    try {
      addLog(
        useExistingDatabase
          ? `Appending ${editedResult.items.length} row${editedResult.items.length === 1 ? "" : "s"} to an existing Notion database...`
          : "Starting Notion write phase...",
        "info"
      );

      const data = (await streamSSE(
        "/api/write",
        payload,
        (msg) => addLog(msg)
      )) as {
        databaseId: string;
        message: string;
        itemsWritten: number;
        propertyCount: number;
        usedExistingDatabase: boolean;
      };

      addLog(data.message, "success");
      setNotionUrl(`https://notion.so/${data.databaseId.replace(/-/g, "")}`);
      setWriteSummary({
        databaseId: data.databaseId,
        itemsWritten: data.itemsWritten,
        propertyCount: data.propertyCount,
        usedExistingDatabase: data.usedExistingDatabase,
      });
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      setSavedDraft(null);
      setPhase("done");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        addLog("Notion write cancelled.", "info");
        setPhase("approving");
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      addLog(`Error: ${message}`, "error");
      setPhase("error");
    }
  };

  const updateSummary = (summary: string) => {
    updateEditedResult((previous) => ({ ...previous, summary }));
  };

  const updateItemValue = (rowIndex: number, column: string, value: string) => {
    updateEditedResult((previous) => ({
      ...previous,
      items: previous.items.map((item, index) =>
        index === rowIndex ? { ...item, [column]: value } : item
      ),
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
      const { [columnName]: _removed, ...nextSchema } = previous.schema;

      return {
        ...previous,
        schema: nextSchema,
        items: previous.items.map((item) => {
          const { [columnName]: _value, ...rest } = item;
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

    const payload: WritePayload = useExistingDatabase && targetDatabaseId.trim()
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
    setSavedDraft(null);
    setFindText("");
    setReplaceText("");
    setShowFindReplace(false);
    setPrompt("");
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  };

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "2rem 1rem", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          🔍 Notion Research Agent
        </h1>
        <p style={{ color: "#666", marginTop: "0.5rem", fontSize: "0.9rem" }}>
          Browse the web → structure findings → write to Notion automatically
        </p>
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

      {phase === "idle" && (
        <div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What do you want to research? e.g. 'Find the top 5 competitors to Linear in the project management space'"
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
            onClick={startResearch}
            disabled={!prompt.trim()}
            style={{
              marginTop: "1rem",
              padding: "0.75rem 1.5rem",
              background: prompt.trim() ? "#000" : "#ccc",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              cursor: prompt.trim() ? "pointer" : "default",
              fontSize: "0.95rem",
              fontWeight: 500,
            }}
          >
            Start Research
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

          <div style={{ marginBottom: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap" }}>
              <div style={{ fontSize: "0.85rem", color: "#555" }}>
                Schema ({schemaEntries.length} properties)
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button
                  onClick={undoEdit}
                  disabled={historyIndex <= 0}
                  style={{
                    padding: "0.45rem 0.8rem",
                    background: historyIndex <= 0 ? "#f3f4f6" : "none",
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    cursor: historyIndex <= 0 ? "default" : "pointer",
                    fontSize: "0.8rem",
                    color: "#333",
                  }}
                >
                  Undo
                </button>
                <button
                  onClick={redoEdit}
                  disabled={historyIndex >= history.length - 1}
                  style={{
                    padding: "0.45rem 0.8rem",
                    background: historyIndex >= history.length - 1 ? "#f3f4f6" : "none",
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    cursor:
                      historyIndex >= history.length - 1 ? "default" : "pointer",
                    fontSize: "0.8rem",
                    color: "#333",
                  }}
                >
                  Redo
                </button>
                <button
                  onClick={addColumn}
                  style={{
                    padding: "0.45rem 0.8rem",
                    background: "none",
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontSize: "0.8rem",
                    color: "#333",
                  }}
                >
                  + Add column
                </button>
              </div>
            </div>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {schemaEntries.map(([name, type], index) => (
                <div
                  key={`${name}-${index}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(180px, 1fr) minmax(140px, 180px) auto",
                    gap: "0.5rem",
                    alignItems: "center",
                  }}
                >
                  <input
                    aria-label={`Column name ${index + 1}`}
                    value={name}
                    onChange={(e) => renameColumn(name, e.target.value)}
                    style={{
                      padding: "0.5rem",
                      border: "1px solid #ddd",
                      borderRadius: 6,
                      width: "100%",
                      boxSizing: "border-box",
                    }}
                  />
                  <select
                    aria-label={`Column type for ${name}`}
                    value={type}
                    onChange={(e) => updateColumnType(name, e.target.value as PropertyType)}
                    style={{
                      padding: "0.5rem",
                      border: "1px solid #ddd",
                      borderRadius: 6,
                      width: "100%",
                      boxSizing: "border-box",
                    }}
                  >
                    {PROPERTY_TYPES.map((propertyType) => (
                      <option key={propertyType} value={propertyType}>
                        {formatPropertyTypeLabel(propertyType)}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => deleteColumn(name)}
                    aria-label={`Delete column ${name}`}
                    style={{
                      padding: "0.45rem 0.8rem",
                      background: "none",
                      border: "1px solid #f5c2c7",
                      borderRadius: 8,
                      cursor: "pointer",
                      fontSize: "0.8rem",
                      color: "#b42318",
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontSize: "0.85rem", color: "#555" }}>
              Rows ({editedResult.items.length})
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                onClick={() => setShowFindReplace((current) => !current)}
                style={{
                  padding: "0.45rem 0.8rem",
                  background: "none",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  color: "#333",
                }}
              >
                {showFindReplace ? "Hide replace" : "Find & replace"}
              </button>
              <button
                onClick={exportJson}
                style={{
                  padding: "0.45rem 0.8rem",
                  background: "none",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  color: "#333",
                }}
              >
                Download JSON
              </button>
              <button
                onClick={exportCsv}
                style={{
                  padding: "0.45rem 0.8rem",
                  background: "none",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  color: "#333",
                }}
              >
                Download CSV
              </button>
            </div>
          </div>

          {showFindReplace && (
            <div
              style={{
                marginBottom: "0.75rem",
                padding: "0.85rem",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                background: "#fafafa",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(180px, 1fr) minmax(180px, 1fr) auto",
                  gap: "0.5rem",
                  alignItems: "center",
                }}
              >
                <input
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  placeholder="Find text"
                  style={{
                    padding: "0.5rem",
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                />
                <input
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  placeholder="Replace with"
                  style={{
                    padding: "0.5rem",
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  onClick={replaceAcrossRows}
                  disabled={!findText}
                  style={{
                    padding: "0.5rem 0.85rem",
                    background: findText ? "#111827" : "#d1d5db",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    cursor: findText ? "pointer" : "default",
                    fontSize: "0.8rem",
                  }}
                >
                  Replace all
                </button>
              </div>
            </div>
          )}

          <div style={{ overflowX: "auto", marginBottom: "1.25rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  {schemaEntries.map(([columnName]) => (
                    <th
                      key={columnName}
                      style={{
                        padding: "0.5rem 0.75rem",
                        textAlign: "left",
                        fontWeight: 500,
                        border: "1px solid #e5e7eb",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {columnName}
                    </th>
                  ))}
                  <th
                    style={{
                      padding: "0.5rem 0.75rem",
                      textAlign: "left",
                      fontWeight: 500,
                      border: "1px solid #e5e7eb",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {editedResult.items.length === 0 ? (
                  <tr>
                    <td
                      colSpan={schemaEntries.length + 1}
                      style={{
                        padding: "0.75rem",
                        border: "1px solid #e5e7eb",
                        color: "#666",
                      }}
                    >
                      All rows removed. Use the “Start over” button below to regenerate results.
                    </td>
                  </tr>
                ) : (
                  editedResult.items.map((item, rowIndex) => (
                    <tr key={rowIndex} style={{ borderBottom: "1px solid #e5e7eb" }}>
                      {schemaEntries.map(([columnName, columnType]) => (
                        <td
                          key={columnName}
                          style={{
                            padding: "0.5rem 0.75rem",
                            border: "1px solid #e5e7eb",
                            minWidth: 180,
                            verticalAlign: "top",
                          }}
                        >
                          <textarea
                            aria-label={`${columnName} for row ${rowIndex + 1}`}
                            value={item[columnName] ?? ""}
                            onChange={(e) => updateItemValue(rowIndex, columnName, e.target.value)}
                            rows={columnType === "rich_text" ? 3 : 2}
                            style={{
                              width: "100%",
                              border: invalidCellLookup.has(`${rowIndex}:${columnName}`)
                                ? "1px solid #f59e0b"
                                : "1px solid #ddd",
                              borderRadius: 6,
                              padding: "0.45rem 0.5rem",
                              fontSize: "0.85rem",
                              fontFamily: "inherit",
                              boxSizing: "border-box",
                              background: invalidCellLookup.has(`${rowIndex}:${columnName}`)
                                ? "#fffbeb"
                                : "#fff",
                              resize: "vertical",
                            }}
                          />
                        </td>
                      ))}
                      <td
                        style={{
                          padding: "0.5rem 0.75rem",
                          border: "1px solid #e5e7eb",
                          verticalAlign: "top",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                          <button
                            onClick={() => moveItem(rowIndex, -1)}
                            disabled={rowIndex === 0}
                            aria-label={`Move row ${rowIndex + 1} up`}
                            style={{
                              padding: "0.45rem 0.7rem",
                              background: rowIndex === 0 ? "#f3f4f6" : "none",
                              border: "1px solid #ddd",
                              borderRadius: 6,
                              cursor: rowIndex === 0 ? "default" : "pointer",
                              fontSize: "0.8rem",
                              color: "#333",
                            }}
                          >
                            ↑
                          </button>
                          <button
                            onClick={() => moveItem(rowIndex, 1)}
                            disabled={rowIndex === editedResult.items.length - 1}
                            aria-label={`Move row ${rowIndex + 1} down`}
                            style={{
                              padding: "0.45rem 0.7rem",
                              background:
                                rowIndex === editedResult.items.length - 1 ? "#f3f4f6" : "none",
                              border: "1px solid #ddd",
                              borderRadius: 6,
                              cursor:
                                rowIndex === editedResult.items.length - 1 ? "default" : "pointer",
                              fontSize: "0.8rem",
                              color: "#333",
                            }}
                          >
                            ↓
                          </button>
                           <button
                             onClick={() => duplicateItem(rowIndex)}
                             aria-label={`Duplicate row ${rowIndex + 1}`}
                             style={{
                               padding: "0.45rem 0.7rem",
                               background: "none",
                               border: "1px solid #ddd",
                               borderRadius: 6,
                               cursor: "pointer",
                               fontSize: "0.8rem",
                               color: "#333",
                             }}
                           >
                             Copy
                           </button>
                           <button
                             onClick={() => removeItem(rowIndex)}
                             aria-label={`Remove row ${rowIndex + 1}`}
                             style={{
                              padding: "0.45rem 0.7rem",
                              background: "none",
                              border: "1px solid #f5c2c7",
                              borderRadius: 6,
                              cursor: "pointer",
                              fontSize: "0.8rem",
                              color: "#b42318",
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

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
              onClick={writeToNotion}
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
              {useExistingDatabase ? "➕ Add to Notion" : "✍️ Write to Notion"} ({editedResult.items.length} rows)
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
        <div
          style={{
            marginTop: "1.5rem",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: 8,
            padding: "1.25rem",
          }}
        >
          <div style={{ fontSize: "1rem", fontWeight: 600, color: "#166534", marginBottom: "0.5rem" }}>
            ✅ Written to Notion!
          </div>
          {writeSummary && (
            <div
              style={{
                marginBottom: "0.9rem",
                padding: "0.75rem 0.9rem",
                background: "#dcfce7",
                borderRadius: 8,
                color: "#166534",
                fontSize: "0.88rem",
              }}
            >
              <div>
                Database mode: {writeSummary.usedExistingDatabase ? "existing database" : "new database"}
              </div>
              <div>Rows written: {writeSummary.itemsWritten}</div>
              <div>Properties written: {writeSummary.propertyCount}</div>
              <div style={{ wordBreak: "break-all" }}>Database ID: {writeSummary.databaseId}</div>
            </div>
          )}
          {notionUrl && (
            <a
              href={notionUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#166534", fontSize: "0.9rem" }}
            >
              Open in Notion →
            </a>
          )}
          <br />
          <button
            onClick={reset}
            style={{
              marginTop: "1rem",
              padding: "0.6rem 1.25rem",
              background: "none",
              border: "1px solid #ddd",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: "0.9rem",
            }}
          >
            New research
          </button>
        </div>
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
              Retry last step
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

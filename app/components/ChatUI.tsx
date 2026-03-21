"use client";

import { useState, useRef } from "react";
import type { ResearchResult } from "@/lib/agent";

type Phase = "idle" | "researching" | "approving" | "writing" | "done" | "error";
type PropertyType = "title" | "rich_text" | "url" | "number" | "select";
type EditableResult = ResearchResult & {
  schema: Record<string, PropertyType>;
};
type WritePayload = EditableResult & { targetDatabaseId?: string };

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

export default function ChatUI() {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [editedResult, setEditedResult] = useState<EditableResult | null>(null);
  const [notionUrl, setNotionUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [useExistingDatabase, setUseExistingDatabase] = useState(false);
  const [targetDatabaseId, setTargetDatabaseId] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const lastActionRef = useRef<"research" | "write" | null>(null);

  const schemaEntries = editedResult
    ? (Object.entries(editedResult.schema) as [string, PropertyType][])
    : [];
  const titleFieldCount = schemaEntries.filter(([, type]) => type === "title").length;
  const hasSchema = schemaEntries.length > 0;
  const targetDatabaseValid = !useExistingDatabase || !!targetDatabaseId.trim();
  const canWrite =
    !!editedResult &&
    editedResult.items.length > 0 &&
    hasSchema &&
    titleFieldCount === 1 &&
    !!editedResult.suggestedDbTitle.trim() &&
    !!editedResult.summary.trim() &&
    targetDatabaseValid;

  let approvalHint: string | null = null;
  if (editedResult) {
    if (titleFieldCount !== 1) {
      approvalHint = "Your schema must contain exactly one title field before writing to Notion.";
    } else if (!targetDatabaseValid) {
      approvalHint = "Enter an existing Notion database ID or switch back to creating a new database.";
    } else if (!editedResult.summary.trim()) {
      approvalHint = "Add a summary before writing to Notion.";
    } else if (!editedResult.suggestedDbTitle.trim()) {
      approvalHint = "Add a database title before writing to Notion.";
    }
  }

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { type, message }]);
  };

  const updateEditedResult = (
    updater: (previous: EditableResult) => EditableResult
  ) => {
    setEditedResult((previous) => (previous ? updater(previous) : previous));
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
    setNotionUrl(null);
    setErrorMessage(null);

    try {
      addLog(`Starting research: "${prompt}"`, "info");

      const data = (await streamSSE(
        "/api/research",
        { prompt },
        (msg) => addLog(msg)
      )) as ResearchResult;

      setEditedResult({
        ...data,
        schema: data.schema as Record<string, PropertyType>,
      });
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
      )) as { databaseId: string; message: string };

      addLog(data.message, "success");
      setNotionUrl(`https://notion.so/${data.databaseId.replace(/-/g, "")}`);
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
    setNotionUrl(null);
    setErrorMessage(null);
    setUseExistingDatabase(false);
    setTargetDatabaseId("");
    setPrompt("");
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
              ⏳ Working…
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
                              border: "1px solid #ddd",
                              borderRadius: 6,
                              padding: "0.45rem 0.5rem",
                              fontSize: "0.85rem",
                              fontFamily: "inherit",
                              boxSizing: "border-box",
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

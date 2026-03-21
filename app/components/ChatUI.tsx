"use client";

import { useState, useRef } from "react";
import type { ResearchResult } from "@/lib/agent";

type Phase = "idle" | "researching" | "approving" | "writing" | "done" | "error";

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

export default function ChatUI() {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [editedResult, setEditedResult] = useState<ResearchResult | null>(null);
  const [notionUrl, setNotionUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastActionRef = useRef<"research" | "write" | null>(null);

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { type, message }]);
  };

  const streamSSE = async (
    url: string,
    body: unknown,
    onUpdate: (msg: string) => void
  ): Promise<unknown> => {
    try {
      abortRef.current = new AbortController();

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        let message = text || `Request failed with status ${res.status}`;

        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {}

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
        "Streaming response ended unexpectedly before completion. The server may have closed the connection. Please check your network and try again."
      );
    } finally {
      abortRef.current = null;
    }
  };

  const startResearch = async () => {
    if (!prompt.trim()) return;
    lastActionRef.current = "research";
    setPhase("researching");
    setLogs([]);
    setResult(null);
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

      setResult(data);
      setEditedResult(data);
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
    if (!editedResult) return;
    lastActionRef.current = "write";
    setPhase("writing");
    setErrorMessage(null);

    try {
      addLog("Starting Notion write phase...", "info");

      const data = (await streamSSE(
        "/api/write",
        editedResult,
        (msg) => addLog(msg)
      )) as { databaseId: string; message: string };

      addLog(data.message, "success");
      setNotionUrl(
        `https://notion.so/${data.databaseId.replace(/-/g, "")}`
      );
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
    setEditedResult((prev) => (prev ? { ...prev, summary } : prev));
  };

  const updateItemValue = (rowIndex: number, column: string, value: string) => {
    setEditedResult((prev) => {
      if (!prev) return prev;

      return {
        ...prev,
        items: prev.items.map((item, index) =>
          index === rowIndex ? { ...item, [column]: value } : item
        ),
      };
    });
  };

  const removeItem = (rowIndex: number) => {
    setEditedResult((prev) => {
      if (!prev) return prev;

      return {
        ...prev,
        items: prev.items.filter((_, index) => index !== rowIndex),
      };
    });
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

    if (lastActionRef.current === "research") {
      void startResearch();
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setPhase("idle");
    setLogs([]);
    setResult(null);
    setEditedResult(null);
    setNotionUrl(null);
    setErrorMessage(null);
    setPrompt("");
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "2rem 1rem", fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          🔍 Notion Research Agent
        </h1>
        <p style={{ color: "#666", marginTop: "0.5rem", fontSize: "0.9rem" }}>
          Browse the web → structure findings → write to Notion automatically
        </p>
      </div>

      {/* Input phase */}
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
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => setPrompt(p)}
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
                {p.slice(0, 40)}…
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

      {/* Activity log */}
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
          {logs.map((log, i) => (
            <div
              key={i}
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

      {/* Approval phase */}
      {phase === "approving" && editedResult && (
        <div style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Review before writing to Notion
          </h2>

          {/* DB title */}
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ fontSize: "0.85rem", color: "#555", display: "block", marginBottom: "0.3rem" }}>
              Database title
            </label>
            <input
              value={editedResult.suggestedDbTitle}
              onChange={(e) =>
                setEditedResult({ ...editedResult, suggestedDbTitle: e.target.value })
              }
              style={{ padding: "0.5rem", border: "1px solid #ddd", borderRadius: 6, width: "100%", boxSizing: "border-box" }}
            />
          </div>

          {/* Summary */}
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

          {/* Schema */}
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.85rem", color: "#555", marginBottom: "0.5rem" }}>
              Schema ({Object.keys(editedResult.schema).length} properties)
            </div>
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
              {Object.entries(editedResult.schema).map(([name, type]) => (
                <span
                  key={name}
                  style={{
                    padding: "0.25rem 0.6rem",
                    background: "#e8f0fe",
                    borderRadius: 4,
                    fontSize: "0.8rem",
                    color: "#1a56db",
                  }}
                >
                  {name} <span style={{ opacity: 0.6 }}>({type})</span>
                </span>
              ))}
            </div>
          </div>

          {/* Items preview table */}
          <div style={{ fontSize: "0.85rem", color: "#555", marginBottom: "0.5rem" }}>
            Rows ({editedResult.items.length})
          </div>
          <div style={{ overflowX: "auto", marginBottom: "1.25rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ background: "#f3f4f6" }}>
                  {Object.keys(editedResult.schema).map((col) => (
                    <th
                      key={col}
                      style={{
                        padding: "0.5rem 0.75rem",
                        textAlign: "left",
                        fontWeight: 500,
                        border: "1px solid #e5e7eb",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col}
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
                      colSpan={Object.keys(editedResult.schema).length + 1}
                      style={{
                        padding: "0.75rem",
                        border: "1px solid #e5e7eb",
                        color: "#666",
                      }}
                    >
                      All rows removed. Use the &quot;Start over&quot; button below to regenerate results.
                    </td>
                  </tr>
                ) : (
                  editedResult.items.map((item, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #e5e7eb" }}>
                      {Object.keys(editedResult.schema).map((col) => (
                        <td
                          key={col}
                          style={{
                            padding: "0.5rem 0.75rem",
                            border: "1px solid #e5e7eb",
                            minWidth: 180,
                            verticalAlign: "top",
                          }}
                        >
                          <textarea
                            aria-label={`${col} for row ${i + 1}`}
                            value={item[col] ?? ""}
                            onChange={(e) => updateItemValue(i, col, e.target.value)}
                            rows={editedResult.schema[col] === "rich_text" ? 3 : 2}
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
                        <button
                          onClick={() => removeItem(i)}
                          aria-label={`Remove row ${i + 1}`}
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
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              onClick={writeToNotion}
              disabled={editedResult.items.length === 0}
              aria-disabled={editedResult.items.length === 0}
              title={
                editedResult.items.length === 0
                  ? "Add or keep at least one row before writing to Notion."
                  : undefined
              }
              style={{
                padding: "0.75rem 1.5rem",
                background: editedResult.items.length > 0 ? "#000" : "#ccc",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: editedResult.items.length > 0 ? "pointer" : "default",
                fontSize: "0.95rem",
                fontWeight: 500,
              }}
            >
              ✍️ Write to Notion ({editedResult.items.length} rows)
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

      {/* Done */}
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

      {/* Error recovery */}
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

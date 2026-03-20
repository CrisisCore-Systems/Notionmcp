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
  const abortRef = useRef<AbortController | null>(null);

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { type, message }]);
  };

  const streamSSE = (
    url: string,
    body: unknown,
    onUpdate: (msg: string) => void
  ): Promise<unknown> => {
    return new Promise(async (resolve, reject) => {
      abortRef.current = new AbortController();

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortRef.current.signal,
      });

      const reader = res.body!.getReader();
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
            else if (event === "complete") resolve(data);
            else if (event === "error") reject(new Error(data.message));
          }
        }
      }
    });
  };

  const startResearch = async () => {
    if (!prompt.trim()) return;
    setPhase("researching");
    setLogs([]);
    setResult(null);
    setEditedResult(null);
    setNotionUrl(null);

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
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      setPhase("error");
    }
  };

  const writeToNotion = async () => {
    if (!editedResult) return;
    setPhase("writing");

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
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      setPhase("error");
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setPhase("idle");
    setLogs([]);
    setResult(null);
    setEditedResult(null);
    setNotionUrl(null);
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
          <div
            style={{
              background: "#f0f4ff",
              borderRadius: 8,
              padding: "0.75rem 1rem",
              fontSize: "0.9rem",
              marginBottom: "1rem",
              color: "#333",
            }}
          >
            {editedResult.summary}
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
                </tr>
              </thead>
              <tbody>
                {editedResult.items.map((item, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #e5e7eb" }}>
                    {Object.keys(editedResult.schema).map((col) => (
                      <td
                        key={col}
                        style={{
                          padding: "0.5rem 0.75rem",
                          border: "1px solid #e5e7eb",
                          maxWidth: 200,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item[col] ?? "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              onClick={writeToNotion}
              style={{
                padding: "0.75rem 1.5rem",
                background: "#000",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
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
          Try again
        </button>
      )}
    </div>
  );
}

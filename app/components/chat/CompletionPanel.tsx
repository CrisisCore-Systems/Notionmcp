"use client";

import type { WriteSummary } from "./types";

type CompletionPanelProps = {
  notionUrl: string | null;
  writeSummary: WriteSummary | null;
  linkActionMessage: string | null;
  canShare: boolean;
  onShare: () => void;
  onCopy: () => void;
  onReset: () => void;
};

export function CompletionPanel({
  notionUrl,
  writeSummary,
  linkActionMessage,
  canShare,
  onShare,
  onCopy,
  onReset,
}: CompletionPanelProps) {
  return (
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
          {writeSummary.providerMode && <div>Provider lane: {writeSummary.providerMode}</div>}
          <div style={{ wordBreak: "break-all" }}>Database ID: {writeSummary.databaseId}</div>
          {(writeSummary.auditUrl || writeSummary.jobUrl) && (
            <div
              style={{
                marginTop: "0.75rem",
                paddingTop: "0.75rem",
                borderTop: "1px solid rgba(22, 101, 52, 0.18)",
                display: "grid",
                gap: "0.25rem",
              }}
            >
              <div style={{ fontWeight: 600 }}>Trust artifacts</div>
              {writeSummary.auditId && <div>Write audit ID: {writeSummary.auditId}</div>}
              {writeSummary.jobId && <div>Durable job ID: {writeSummary.jobId}</div>}
              {writeSummary.auditTrail && (
                <>
                  <div>
                    Evidence set: {writeSummary.auditTrail.sourceSet.length} source
                    {writeSummary.auditTrail.sourceSet.length === 1 ? "" : "s"} from{" "}
                    {writeSummary.auditTrail.extractionCounts.pagesBrowsed} page
                    {writeSummary.auditTrail.extractionCounts.pagesBrowsed === 1 ? "" : "s"} across{" "}
                    {writeSummary.auditTrail.extractionCounts.searchQueries} search quer
                    {writeSummary.auditTrail.extractionCounts.searchQueries === 1 ? "y" : "ies"}
                  </div>
                  <div>
                    Row audit: {writeSummary.auditTrail.rowsAttempted} attempted,{" "}
                    {writeSummary.auditTrail.rowsConfirmedWritten} written,{" "}
                    {writeSummary.auditTrail.rowsSkippedAsDuplicates} duplicates,{" "}
                    {writeSummary.auditTrail.rowsLeftUnresolved} unresolved
                  </div>
                </>
              )}
              {writeSummary.auditUrl && (
                <div>
                  Write audit JSON:{" "}
                  <a href={writeSummary.auditUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#166534" }}>
                    download
                  </a>
                </div>
              )}
              {writeSummary.jobUrl && (
                <div>
                  Durable job JSON:{" "}
                  <a href={writeSummary.jobUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#166534" }}>
                    inspect checkpoint log
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {notionUrl && (
        <div style={{ display: "grid", gap: "0.65rem" }}>
          <div style={{ fontSize: "0.88rem", color: "#166534" }}>
            On Android, the easiest flow is: tap the link, and if your browser stays open,
            use Share or Copy to hand the same link to the Notion app.
          </div>
          <div
            style={{
              padding: "0.7rem 0.8rem",
              background: "#dcfce7",
              borderRadius: 8,
              fontSize: "0.84rem",
              color: "#166534",
            }}
          >
            1. Tap <strong>Open in Notion</strong>.
            <br />
            2. If Android opens the browser instead of the app, tap{" "}
            <strong>Share link</strong> or <strong>Copy Android/web link</strong>.
            <br />
            3. Open the shared or copied link in the Notion app.
          </div>
          <div style={{ display: "flex", gap: "0.65rem", flexWrap: "wrap", alignItems: "center" }}>
            <a
              href={notionUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#166534", fontSize: "0.9rem" }}
            >
              Open in Notion →
            </a>
            {canShare && (
              <button
                onClick={onShare}
                style={{
                  padding: "0.45rem 0.8rem",
                  background: "none",
                  border: "1px solid #86efac",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  color: "#166534",
                }}
              >
                Share link
              </button>
            )}
            <button
              onClick={onCopy}
              style={{
                padding: "0.45rem 0.8rem",
                background: "none",
                border: "1px solid #86efac",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: "0.85rem",
                color: "#166534",
              }}
            >
              Copy Android/web link
            </button>
          </div>
          <div style={{ wordBreak: "break-all", fontSize: "0.82rem", color: "#166534" }}>
            {notionUrl}
          </div>
          {linkActionMessage && (
            <div style={{ fontSize: "0.82rem", color: "#166534" }}>{linkActionMessage}</div>
          )}
        </div>
      )}
      <br />
      <button
        onClick={onReset}
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
  );
}

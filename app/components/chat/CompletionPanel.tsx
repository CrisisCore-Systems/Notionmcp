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
    <div className="completion-shell">
        <div className="completion-title">
          ✅ Same Notion row is Packet Ready
        </div>
      {writeSummary && (
        <div className="completion-panel">
            {writeSummary.notionQueue && (
              <div
                style={{
                marginBottom: "0.75rem",
                paddingBottom: "0.75rem",
                borderBottom: "1px solid rgba(22, 101, 52, 0.18)",
                display: "grid",
                  gap: "0.25rem",
                }}
              >
                <div style={{ fontWeight: 600 }}>Updated row metadata</div>
                <div
                  className="completion-grid"
                >
                  <div>
                    <strong>Backlog row</strong>
                    <br />
                    {writeSummary.notionQueue.title || writeSummary.notionQueue.pageId}
                  </div>
                  <div>
                    <strong>Current stage</strong>
                    <br />
                    Packet Ready
                  </div>
                  <div>
                    <strong>Claimed by</strong>
                    <br />
                    {writeSummary.notionQueue.claimedBy}
                  </div>
                  <div>
                    <strong>Claimed at</strong>
                    <br />
                    {writeSummary.notionQueue.claimedAt
                      ? new Date(writeSummary.notionQueue.claimedAt).toLocaleString()
                      : "Not recorded"}
                  </div>
                  <div style={{ wordBreak: "break-all" }}>
                    <strong>Run ID</strong>
                    <br />
                    {writeSummary.notionQueue.runId}
                  </div>
                  <div>
                    <strong>Research mode</strong>
                    <br />
                    {writeSummary.research?.mode ?? "fast"}
                  </div>
                  <div>
                    <strong>Source count</strong>
                    <br />
                    {writeSummary.auditTrail?.sourceSet.length ?? 0}
                  </div>
                  <div>
                    <strong>Rejected URLs</strong>
                    <br />
                    {writeSummary.research?.rejectedUrlCount ?? writeSummary.auditTrail?.rejectedUrls.length ?? 0}
                  </div>
                </div>
                <div>Run path: Ready → In Progress → Needs Review → Packet Ready</div>
              </div>
            )}
            <div>
            Database mode: {writeSummary.usedExistingDatabase ? "existing database" : "new database"}
          </div>
          <div>Rows written: {writeSummary.itemsWritten}</div>
          <div>Properties written: {writeSummary.propertyCount}</div>
          {writeSummary.providerMode && <div>Provider lane: {writeSummary.providerMode}</div>}
          {writeSummary.research && (
            <div style={{ marginTop: "0.4rem" }}>
              Research lane: {writeSummary.research.mode ?? "fast"}
              {writeSummary.research.degraded ? " (degraded fallback)" : ""}. Reviewed{" "}
              {writeSummary.research.uniqueDomainCount} domain
              {writeSummary.research.uniqueDomainCount === 1 ? "" : "s"} across{" "}
              {writeSummary.research.sourceClassCount} source class
              {writeSummary.research.sourceClassCount === 1 ? "" : "es"}
              {typeof writeSummary.research.averageQualityScore === "number"
                ? ` with an average source quality score of ${writeSummary.research.averageQualityScore.toFixed(1)}`
                : ""}
              . Rejected URLs: {writeSummary.research.rejectedUrlCount}.
            </div>
          )}
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
                    Reviewed rows: {writeSummary.auditTrail.rowsReviewed}. Deterministic operation keys:{" "}
                    {writeSummary.auditTrail.rows.length}.
                  </div>
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
                    {writeSummary.auditTrail.rowsConfirmedAfterReconciliation} reconciled after ambiguity,{" "}
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
            1. Tap <strong>Open updated row</strong>.
            <br />
            2. If Android opens the browser instead of the app, tap{" "}
            <strong>Share link</strong> or <strong>Copy Android/web link</strong>.
            <br />
            3. Open the shared or copied link in the Notion app.
          </div>
          <div className="completion-links">
            <a
              href={notionUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#166534", fontSize: "0.9rem" }}
            >
              Open updated row →
            </a>
            {canShare && (
              <button
                onClick={onShare}
                className="operator-button-secondary"
              >
                Share link
              </button>
            )}
            <button
              onClick={onCopy}
              className="operator-button-secondary"
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
        className="operator-button-secondary"
        style={{ marginTop: "1rem" }}
      >
        Process another backlog item
      </button>
    </div>
  );
}

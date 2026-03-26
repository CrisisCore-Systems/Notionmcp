import ChatUI from "./components/ChatUI";
import {
  getDeploymentMode,
  getDeploymentReadinessError,
  getDurableJobsWarning,
  warnIfDurableJobsNeedLongLivedHost,
} from "@/lib/deployment-boundary";
import { getCurrentNotionProviderState } from "@/lib/notion";

const ENVIRONMENT_VARIABLES = [
  "GEMINI_API_KEY",
  "NOTION_TOKEN",
  "NOTION_PARENT_PAGE_ID",
];

export default function HomePage() {
  warnIfDurableJobsNeedLongLivedHost();
  const durableJobsWarning = getDurableJobsWarning();
  const deploymentMode = getDeploymentMode();
  const deploymentReadinessError = getDeploymentReadinessError();
  const notionProviderState = getCurrentNotionProviderState();

  return (
    <main style={{ minHeight: "100vh", padding: "2rem 1rem 3rem" }}>
      {deploymentReadinessError && (
        <div
          style={{
            maxWidth: 800,
            margin: "0 auto 1rem",
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            borderRadius: 12,
            padding: "1rem 1.25rem",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem", color: "#991b1b" }}>
            Deployment boundary mismatch
          </h2>
          <p style={{ margin: 0, color: "#991b1b", lineHeight: 1.6, fontSize: "0.92rem" }}>
            {deploymentReadinessError}
          </p>
        </div>
      )}
      {durableJobsWarning && (
        <div
          style={{
            maxWidth: 800,
            margin: "0 auto 1rem",
            background: "#fff7ed",
            border: "1px solid #fdba74",
            borderRadius: 12,
            padding: "1rem 1.25rem",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem", color: "#9a3412" }}>
            {durableJobsWarning.title}
          </h2>
          <p style={{ margin: 0, color: "#9a3412", lineHeight: 1.6, fontSize: "0.92rem" }}>
            {durableJobsWarning.message} If you only want short-lived debugging behavior, explicitly set{" "}
            <code>NOTIONMCP_RUN_JOBS_INLINE=true</code> and accept that detached recovery guarantees are reduced. If
            your host is intentionally inline-only, set <code>NOTIONMCP_HOST_DURABILITY=inline-only</code> so the app
            degrades honestly instead of pretending detached workers are durable.
          </p>
        </div>
      )}
      <div
        style={{
          maxWidth: 800,
          margin: "0 auto 1.5rem",
          background: "#eff6ff",
          border: "1px solid #bfdbfe",
          borderRadius: 12,
          padding: "1rem 1.25rem",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          display: "grid",
          gap: "0.55rem",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: 0 }}>Queue-first workflow</h2>
        <p style={{ margin: 0, color: "#1e3a8a", lineHeight: 1.6, fontSize: "0.92rem" }}>
          Claim the next Ready item from Notion, research it durably, review it, and write the approved packet back
          into the same row.
        </p>
        <div style={{ fontSize: "0.9rem", color: "#1d4ed8", lineHeight: 1.6 }}>
          <strong>Lifecycle:</strong> Ready → In Progress → Needs Review → Packet Ready
        </div>
        <div style={{ fontSize: "0.9rem", color: "#1d4ed8", lineHeight: 1.6 }}>
          <strong>Default path:</strong> local MCP handles queue intake and reviewed write-back.
        </div>
        <div style={{ fontSize: "0.9rem", color: "#1d4ed8", lineHeight: 1.6 }}>
          <strong>Alternate lane:</strong> <code>direct-api</code> is available only when intentionally selected.
        </div>
      </div>
      <div
        style={{
          maxWidth: 800,
          margin: "0 auto 1.5rem",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: "1rem 1.25rem",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Quick setup</h2>
        <ol style={{ margin: 0, paddingLeft: "1.25rem", color: "#4b5563", lineHeight: 1.6 }}>
          <li>Copy <code>.env.example</code> to <code>.env.local</code>.</li>
          <li>Set the following variables before pulling your next Notion queue item:</li>
        </ol>
        <ul style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem", color: "#111827" }}>
          {ENVIRONMENT_VARIABLES.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <p style={{ margin: "0.75rem 0 0", color: "#4b5563", lineHeight: 1.6, fontSize: "0.92rem" }}>
          Deployment mode: <strong>{deploymentMode}</strong>. Localhost API use works with just those variables. The
          default queue loop is: claim the next Ready row in Notion, move it to In Progress, review the packet, then
          write the approved enrichment back into the same row. If
          you intentionally expose the app for a tightly controlled private deployment, also set{" "}
          <code>APP_ALLOWED_ORIGIN</code> and <code>APP_ACCESS_TOKEN</code>. Remote private-host mode also requires
          durable detached jobs plus <code>PERSISTED_STATE_ENCRYPTION_KEY</code>, then enter that access token in the
          UI before starting a run.
        </p>
      </div>
      <div
        style={{
          maxWidth: 800,
          margin: "0 auto 1.5rem",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: "1rem 1.25rem",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          display: "grid",
          gap: "0.75rem",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: 0 }}>Operator-visible outcomes</h2>
        <div style={{ fontSize: "0.92rem", color: "#111827", lineHeight: 1.6 }}>
          <strong>The run survives disconnects:</strong> durable jobs keep processing and reconnect to the same backlog
          item instead of restarting from a blank prompt.
        </div>
        <div style={{ fontSize: "0.92rem", color: "#111827", lineHeight: 1.6 }}>
          <strong>The row does not get rewritten blindly:</strong> the queue row pauses in review before the workspace
          changes, whether you use the fast lane or the deeper research lane.
        </div>
        <div style={{ fontSize: "0.92rem", color: "#111827", lineHeight: 1.6 }}>
          <strong>You approve before the workspace changes:</strong> local MCP is the default control-plane path
          (<code>{notionProviderState.mode}</code>, {notionProviderState.description}), while direct API stays an
          intentionally selected alternate lane.
        </div>
        <div style={{ fontSize: "0.92rem", color: "#111827", lineHeight: 1.6 }}>
          <strong>You can inspect what happened afterward:</strong> every durable run can be inspected via{" "}
          <code>/api/jobs/{"{jobId}"}</code>, and completed writes also persist row-level audit evidence at{" "}
          <code>/api/write-audits/{"{auditId}"}</code>.
        </div>
      </div>
      <ChatUI />
    </main>
  );
}

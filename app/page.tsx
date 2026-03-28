import { cookies } from "next/headers";
import ChatUI from "./components/ChatUI";
import { NotionConnectionCard } from "./components/NotionConnectionCard";
import {
  getDeploymentMode,
  getDeploymentReadinessError,
  getDurableJobsWarning,
  warnIfDurableJobsNeedLongLivedHost,
} from "@/lib/deployment-boundary";
import { getCurrentNotionProviderState } from "@/lib/notion";
import {
  ACTIVE_NOTION_CONNECTION_COOKIE_NAME,
  getNotionConnectionStatus,
} from "@/lib/notion-oauth";

const ENVIRONMENT_VARIABLES = [
  "GEMINI_API_KEY",
  "NOTION_TOKEN",
  "NOTION_PARENT_PAGE_ID",
];

export default async function HomePage() {
  warnIfDurableJobsNeedLongLivedHost();
  const durableJobsWarning = getDurableJobsWarning();
  const deploymentMode = getDeploymentMode();
  const deploymentReadinessError = getDeploymentReadinessError();
  const notionProviderState = getCurrentNotionProviderState();
  const cookieStore = await cookies();
  const activeConnectionId = cookieStore.get(ACTIVE_NOTION_CONNECTION_COOKIE_NAME)?.value?.trim() ?? null;
  const notionConnectionStatus = await getNotionConnectionStatus(activeConnectionId);

  return (
    <main className="landing-root">
      <div className="landing-shell">
        <section className="landing-hero">
          <div className="hero-panel">
            <div className="hero-kicker">Notion Queue Operations</div>
            <h1 className="hero-title">Run a reviewed Notion backlog.</h1>
            <p className="hero-copy">
              Claim the next <code>Ready</code> row, run research, pause at review, and move it to <code>Packet Ready</code>
              after approval.
            </p>
            <div className="hero-actions">
              <a className="hero-primary" href="#operator-console">
                Open operator console
              </a>
              <a className="hero-secondary" href="/api/status" target="_blank" rel="noopener noreferrer">
                Inspect system status
              </a>
            </div>
            <div className="hero-metrics">
              <div className="metric-card">
                <span className="metric-value">4-stage</span>
                <span className="metric-label">Ready to Packet Ready with review in the middle.</span>
              </div>
              <div className="metric-card">
                <span className="metric-value">Durable</span>
                <span className="metric-label">Jobs persist and reconnect.</span>
              </div>
              <div className="metric-card">
                <span className="metric-value">Audited</span>
                <span className="metric-label">Completed writes leave proof artifacts.</span>
              </div>
            </div>
          </div>

          <aside className="hero-side">
            <div>
              <div className="side-overline">Workflow shape</div>
              <h2 className="side-title">Reviewed execution.</h2>
            </div>
            <div className="workflow-list">
              <div className="workflow-step">
                <div className="workflow-badge">1</div>
                <div>
                  <strong>Claim queue item</strong>
                  <span>Move the next eligible row into active work.</span>
                </div>
              </div>
              <div className="workflow-step">
                <div className="workflow-badge">2</div>
                <div>
                  <strong>Research durably</strong>
                  <span>Run research with reconnectable history.</span>
                </div>
              </div>
              <div className="workflow-step">
                <div className="workflow-badge">3</div>
                <div>
                  <strong>Review the packet</strong>
                  <span>Pause at <code>Needs Review</code> for operator edits.</span>
                </div>
              </div>
              <div className="workflow-step">
                <div className="workflow-badge">4</div>
                <div>
                  <strong>Write with proof</strong>
                  <span>Write the approved packet and keep the audit trail.</span>
                </div>
              </div>
            </div>
          </aside>
        </section>

        <div className="banner-grid">
          {deploymentReadinessError && (
            <div className="banner banner-error">
              <h2>Deployment boundary mismatch</h2>
              <p>{deploymentReadinessError}</p>
            </div>
          )}
          {durableJobsWarning && (
            <div className="banner banner-warning">
              <h2>{durableJobsWarning.title}</h2>
              <p>
                {durableJobsWarning.message} For short-lived debugging, set <code>NOTIONMCP_RUN_JOBS_INLINE=true</code>.
                If the host is intentionally inline-only, set <code>NOTIONMCP_HOST_DURABILITY=inline-only</code>.
              </p>
            </div>
          )}
        </div>

        <section className="landing-grid">
          <div className="card-stack">
            <article className="info-card">
              <h2 className="card-heading">Queue-first by default</h2>
              <p className="card-copy">
                Local MCP handles queue intake and reviewed write-back. <code>direct-api</code> stays an explicit
                alternate lane.
              </p>
              <div className="status-chip-row" style={{ marginTop: "1rem" }}>
                <span className="status-chip ready">Ready</span>
                <span className="status-chip progress">In Progress</span>
                <span className="status-chip review">Needs Review</span>
                <span className="status-chip done">Packet Ready</span>
                <span className="status-chip error">Error</span>
              </div>
              <div className="feature-grid">
                <div className="feature-tile">
                  <strong>Default lane</strong>
                  <span><code>{notionProviderState.mode}</code>: {notionProviderState.description}.</span>
                </div>
                <div className="feature-tile">
                  <strong>Reconnectable runs</strong>
                  <span>Durable jobs keep enough history for resume.</span>
                </div>
                <div className="feature-tile">
                  <strong>Human review</strong>
                  <span>Rows pause before write-back.</span>
                </div>
                <div className="feature-tile">
                  <strong>Traceable writes</strong>
                  <span>Each completion leaves job and audit artifacts.</span>
                </div>
              </div>
            </article>

            <article className="callout-card">
              <h2 className="card-heading">Quick setup</h2>
              <p className="card-copy">
                Fill the core variables and keep deployment mode at <code>{deploymentMode}</code>.
              </p>
              <div className="env-list" style={{ marginTop: "1rem" }}>
                {ENVIRONMENT_VARIABLES.map((name) => (
                  <span key={name} className="env-pill">
                    {name}
                  </span>
                ))}
              </div>
            </article>
          </div>

          <aside className="card-rail">
            <NotionConnectionCard
              oauthConfigured={notionConnectionStatus.oauth.configured}
              missingEnvVars={notionConnectionStatus.oauth.missingEnvVars}
              activeConnection={notionConnectionStatus.activeConnection}
              savedConnectionCount={notionConnectionStatus.savedConnections.length}
            />
            <article className="status-card">
              <h2 className="card-heading">What the operator sees</h2>
              <p className="card-copy">
                Runs survive disconnects, edits happen before write-back, and artifacts remain available after completion.
              </p>
              <div className="feature-tile">
                <strong>Execution artifact</strong>
                <span>Inspect <code>/api/jobs/{"{jobId}"}</code> for checkpoints and terminal state.</span>
              </div>
              <div className="feature-tile">
                <strong>Write artifact</strong>
                <span>Inspect <code>/api/write-audits/{"{auditId}"}</code> for approved payloads and write metadata.</span>
              </div>
            </article>
          </aside>
        </section>

        <section id="operator-console" className="console-frame">
          <div className="console-caption">
            <div>
              <div className="console-label">Operator Console</div>
              <h2 className="console-title">Run the queue.</h2>
            </div>
            <p className="console-copy">
              Claim, research, review, and write back.
            </p>
          </div>
          <ChatUI />
        </section>
      </div>
    </main>
  );
}

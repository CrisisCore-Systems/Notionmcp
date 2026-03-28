type NotionConnectionCardProps = {
  oauthConfigured: boolean;
  missingEnvVars: string[];
  activeConnection: {
    workspaceName: string;
    workspaceId: string;
    workspaceIcon: string | null;
    owner: {
      type: string;
      userName: string | null;
    };
  } | null;
  savedConnectionCount: number;
};

export function NotionConnectionCard({
  oauthConfigured,
  missingEnvVars,
  activeConnection,
  savedConnectionCount,
}: NotionConnectionCardProps) {
  const ownerLabel = activeConnection?.owner.userName || activeConnection?.owner.type || "Notion operator";

  return (
    <article className="status-card">
      <h2 className="card-heading">Linked Workspace</h2>
      {activeConnection ? (
        <>
          <p className="card-copy">
            {activeConnection.workspaceName} is linked to this browser session.
          </p>
          <div className="feature-tile">
            <strong>{activeConnection.workspaceIcon ? `${activeConnection.workspaceIcon} ` : ""}{activeConnection.workspaceName}</strong>
            <span>
              Workspace ID {activeConnection.workspaceId}. Owner: {ownerLabel}. Saved connections on this host: {savedConnectionCount}.
            </span>
          </div>
          <div className="operator-card__actions" style={{ marginTop: 0 }}>
            <a className="operator-button" href="/api/notion/connect">
              Reconnect Notion
            </a>
            <a className="operator-button-secondary" href="/api/notion/disconnect">
              Disconnect browser session
            </a>
          </div>
        </>
      ) : oauthConfigured ? (
        <>
          <p className="card-copy">
            Connect your Notion workspace with OAuth.
          </div>
          <div className="operator-card__actions" style={{ marginTop: 0 }}>
            <a className="operator-button" href="/api/notion/connect">
              Connect with Notion
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="card-copy">
            Notion OAuth is not configured yet.
          </p>
          <div className="feature-tile">
            <strong>Missing OAuth env vars</strong>
            <span>{missingEnvVars.join(", ")}</span>
          </div>
        </>
      )}
    </article>
  );
}
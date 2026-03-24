import ChatUI from "./components/ChatUI";
import { getDurableJobsWarning, warnIfDurableJobsNeedLongLivedHost } from "@/lib/deployment-boundary";

const ENVIRONMENT_VARIABLES = [
  "GEMINI_API_KEY",
  "NOTION_TOKEN",
  "NOTION_PARENT_PAGE_ID",
];

export default function HomePage() {
  warnIfDurableJobsNeedLongLivedHost();
  const durableJobsWarning = getDurableJobsWarning();

  return (
    <main style={{ minHeight: "100vh", padding: "2rem 1rem 3rem" }}>
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
            <code>NOTIONMCP_RUN_JOBS_INLINE=true</code> and accept that detached recovery guarantees are reduced.
          </p>
        </div>
      )}
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
          <li>Set the following variables before running a research session:</li>
        </ol>
        <ul style={{ margin: "0.75rem 0 0", paddingLeft: "1.25rem", color: "#111827" }}>
          {ENVIRONMENT_VARIABLES.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <p style={{ margin: "0.75rem 0 0", color: "#4b5563", lineHeight: 1.6, fontSize: "0.92rem" }}>
          Localhost API use works with just those variables. If you intentionally expose the app for a
          tightly controlled private deployment, also set <code>APP_ALLOWED_ORIGIN</code> and{" "}
          <code>APP_ACCESS_TOKEN</code>, then enter that access token in the UI before starting a run.
        </p>
      </div>
      <ChatUI />
    </main>
  );
}

import ChatUI from "./components/ChatUI";

const ENVIRONMENT_VARIABLES = [
  "GEMINI_API_KEY",
  "NOTION_TOKEN",
  "NOTION_PARENT_PAGE_ID",
];

export default function HomePage() {
  return (
    <main style={{ minHeight: "100vh", padding: "2rem 1rem 3rem" }}>
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
      </div>
      <ChatUI />
    </main>
  );
}

export default function NotFound() {
  return (
    <main className="landing-root">
      <div className="landing-shell">
        <section className="console-frame" style={{ marginTop: "2rem" }}>
          <div className="console-caption">
            <div>
              <div className="console-label">404</div>
              <h1 className="console-title">Page not found.</h1>
            </div>
            <p className="console-copy">The requested page does not exist in this workspace.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
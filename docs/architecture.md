# Architecture overview

This repository is a **private operator tool, not a public SaaS product**.

Primary references:

- [Architecture overview PNG](./architecture-overview.png)
- [Architecture overview SVG](./architecture-overview.svg)

Operational flow:

1. The operator submits a prompt in the Next.js UI.
2. The research route runs Gemini with search and browse tools, then validates and reconciles the extracted rows.
3. The approval UI lets the operator review schema, row values, and provenance before any write happens.
4. The write route creates or reuses a Notion database, writes rows with deterministic operation keys, preserves provenance metadata, and reconciles ambiguous partial failures before suggesting a resume point.
5. Each write run returns a structured operator audit trail with the source set, extraction counts, rejected URLs, attempted rows, confirmed writes, duplicate skips, and unresolved rows.
6. The completion panel now exposes both persisted verification artifacts: `/api/write-audits/{auditId}` for the write audit JSON and `/api/jobs/{jobId}` for the durable job checkpoint/event log JSON.

Research posture:

- **Fast lane** keeps the original low-latency caps for reviewed research.
- **Deep research** raises the evidence budget and balances reviewed pages across unique domains and source classes before the operator approves a write.

Deployment posture:

- **`localhost-operator`** is the default workstation mode.
- **`remote-private-host`** is the intentional remote mode and fails closed unless remote access controls, persisted-state encryption, and detached durable jobs are all configured.

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

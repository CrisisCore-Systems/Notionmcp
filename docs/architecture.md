# Architecture overview

This repository is a **private operator tool, not a public SaaS product**.

Primary references:

- [Architecture overview SVG](./architecture-overview.svg)

Operational flow:

1. A backlog row starts in Notion with `Status=Ready`.
2. The app claims that row through local MCP, moves it to `In Progress`, and records `Claimed At`, `Claimed By`, and `Run ID`.
3. A durable research run gathers evidence, survives disconnects, and advances the same row to `Needs Review`.
4. The operator reviews the packet before any write-back happens.
5. The approved write enriches the same Notion row and advances it to `Packet Ready`.
6. The completion panel exposes both persisted verification artifacts: `/api/write-audits/{auditId}` for the write audit JSON and `/api/jobs/{jobId}` for the durable job checkpoint/event log JSON.

Queue-first visual structure:

```text
Notion backlog row
  ↓ claim
Durable research run
  ├── planner
  ├── extractor
  └── verifier
  ↓ review
Approved packet
  ↓ write-back
Same Notion row enriched and advanced
```

Research posture:

- **Fast lane** keeps the original low-latency caps for reviewed research.
- **Deep research** raises the evidence budget and balances reviewed pages across unique domains and source classes before the operator approves a write.

Visible operator outcomes:

- **The run survives disconnects**
- **The row does not get rewritten blindly**
- **You approve before the workspace changes**
- **You can inspect what happened afterward**

Deployment posture:

- **`localhost-operator`** is the default workstation mode.
- **`remote-private-host`** is the intentional remote mode and fails closed unless remote access controls, persisted-state encryption, and detached durable jobs are all configured.

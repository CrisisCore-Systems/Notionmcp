# Architecture overview

This repository is a public reference implementation for a private operator workflow. The control plane is queue-first, the runtime is durable by default, and the write surface is reviewed before the backlog row changes.

## System shape

1. A Notion backlog row starts in `Status=Ready`.
2. The app claims the row through `local-mcp`, moves it to `In Progress`, and records operator metadata.
3. A durable job performs research and streams reconnectable progress events.
4. The operator reviews the packet in `Needs Review`.
5. An approved write enriches the same row and advances it to `Packet Ready`.
6. Verification artifacts remain available after completion through `/api/jobs/{jobId}` and `/api/write-audits/{auditId}`.

## Control plane

The canonical control plane is the local Notion MCP transport.

- `local-mcp` is the default queue intake and reviewed write path.
- `direct-api` exists as an alternate lane for intentional operator use, not as the architectural default.
- The repo exposes route contracts on `GET` so the runtime surface and docs describe the same provider posture.

See [docs/decisions/0001-local-mcp-default.md](./decisions/0001-local-mcp-default.md) for the decision record behind that split.

## Durable job model

This repo uses `durable job` as the canonical term for the persisted execution subsystem.

- Research and write routes create durable job records immediately.
- The job log stores replayable events so reconnecting clients can resume the same execution stream.
- Checkpoints prevent writes from replaying already confirmed work after disconnects or worker restarts.
- Detached durable jobs are the default execution mode on supported hosts.

Operator-facing consequence: the run can survive browser disconnects without pretending a stateless request is enough.

## Persistence model

Persisted state lives under `.notionmcp-data/` by default:

- `.notionmcp-data/jobs` for durable job records
- `.notionmcp-data/write-audits` for write verification artifacts
- `.notionmcp-data/request-rate-limits` for remote private-host coordination state
- `.notionmcp-data/operator-metrics.json` for operator metrics

Retention defaults to 30 days for jobs, write audits, and remote rate-limit state. Remote private-host mode requires `PERSISTED_STATE_ENCRYPTION_KEY` so persisted JSON is encrypted at rest.

See [docs/operator-runbook.md](./operator-runbook.md) for backup, restore, migration, and incident guidance.

## Review and write model

The review boundary is explicit.

- Research produces a packet for operator review before write-back.
- The write path clamps Notion field payloads to Notion-safe lengths.
- Row-level provenance metadata is persisted when the database supports the operator fields.
- Ambiguous partial write failures trigger reconciliation before the UI tells the operator where to resume.

Operator-facing consequence: the same row is enriched and advanced, but not rewritten blindly.

## Failure semantics

Expected failure and recovery behavior:

1. Routes allocate a durable job ID before long-running work begins.
2. If the browser tab closes, detached execution continues on supported hosts.
3. Reconnecting clients replay missed events from the durable job log.
4. Write resumes start from the next unresolved checkpoint, not from the beginning.
5. When ambiguity remains, the operator inspects the write audit or durable job artifact before retrying.

## Deployment boundary

Supported modes:

- `localhost-operator`: trusted workstation mode, detached durable jobs by default, inline fallback only when declared explicitly
- `remote-private-host`: single long-lived private host with explicit origin control, access token, persisted-state encryption, writable local state, and detached durable jobs

Unsupported shapes:

- ephemeral serverless hosts that cannot keep detached workers alive
- multi-instance deployments without shared persistence
- public internet exposure without additional containment and monitoring

The runtime banner for detached durable jobs is part of the expected healthy posture. Operators should treat its presence as confirmation that the app is running in durable mode rather than as a decorative UI flourish.

## Trust boundaries

The main trust boundaries are:

- browser isolation and URL eligibility checks before page fetches
- request origin and token validation for remote private-host mode
- explicit review before write-back
- persisted verification artifacts after execution

See [docs/security-model.md](./security-model.md) for the concrete boundary guarantees and limitations.# Architecture overview

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

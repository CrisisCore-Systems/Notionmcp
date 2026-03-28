# Notion MCP Backlog Desk

**Claim the next Ready item from Notion, research it durably, review it, and write the approved packet back into the same row.**

> **Default path:** Notion queue intake and reviewed writes run through local MCP.
> **Alternate lane:** direct API is available only when you intentionally select it.

![Same Notion row moves from Ready to Packet Ready](docs/architecture-overview.svg)

This repository is a **public reference implementation for a private operator workflow**. The source is visible, the package stays `private: true`, and the shipped deployment posture is a single-operator workstation or tightly controlled private host rather than a public SaaS service.

Notion MCP Backlog Desk is built around one visible queue workflow:

- **Notion is the queue**
- **MCP is the intake path**
- **the app is the reviewed execution layer**
- **the same row gets enriched and advanced**

The operator-visible outcomes are simple:

- **The run survives disconnects**
- **The row does not get rewritten blindly**
- **You approve before the workspace changes**
- **You can inspect what happened afterward**

## Why this exists

This app is not trying to be general-purpose agent chat. It exists to make one queue-first workflow reliable: claim the next backlog row, research it with bounded evidence gathering, pause for operator review, and write the approved packet back into the same row with durable verification artifacts.

The strongest product promise in this repo is not just "research in Notion." It is **durable, reviewed, inspectable Notion backlog execution**. Every completed or failed run leaves behind operator-facing proof surfaces:

- `/api/jobs/{jobId}` exposes the durable job record, checkpoints, and replayable event history
- `/api/write-audits/{auditId}` exposes the write audit record and resulting write metadata

Inspect the job artifact when you need to understand execution flow or resume state. Inspect the write audit when you need to verify what was approved, what write path executed, and what record was updated.

## At a glance

| Topic | Summary |
| --- | --- |
| Product stance | Public reference implementation for a private operator workflow |
| Canonical queue path | `local-mcp` |
| Alternate write lane | `direct-api` |
| Notion-native link state | OAuth workspace binding plus linked database discovery |
| Durable execution | Persisted durable jobs with reconnectable SSE replay |
| Verification artifacts | `/api/jobs/{jobId}` and `/api/write-audits/{auditId}` |
| Supported remote posture | Single long-lived private host with writable local persistence |

## Operator workflow

1. Claim the next `Ready` row from Notion through local MCP.
2. Start a durable job that persists checkpoints and stream events under `.notionmcp-data/jobs`.
3. Choose a research lane: fast for bounded latency, deep for broader evidence gathering.
4. Review the packet while the row sits in `Needs Review`.
5. Approve the write and enrich the same row.
6. Inspect the durable job or write audit record if you need proof, replay, or recovery context.

### Before / after on the same Notion row

| Before | After |
| --- | --- |
| `Name` | `Name` |
| `Research Prompt` | `Research Prompt` |
| `Status = Ready` | `Status = Packet Ready` |
| — | `Claimed At` |
| — | `Claimed By` |
| — | `Run ID` |
| — | `Research Summary` |
| — | `Recommended Direction` |
| — | `Competitors` |
| — | `Source Count` |
| — | `Audit URL` |

## Repository profile

- **Description**: Notion MCP backlog desk for queue-based durable research runs and audited Notion write-back.
- **Topics**: `nextjs`, `gemini`, `notion`, `mcp`, `playwright`, `web-research`, `human-in-the-loop`, `private-operator-tool`
- **Release tags**: `v0.2.1` (worker path + remote encryption hardening), `v0.2.x` (stability and evidence hardening). Mirror these in GitHub releases/tags so operators can verify what build they are running, and keep `CHANGELOG.md` aligned with each tag.

## What this repository is

This repository is a **small runnable Next.js app** for one sharp Notion-native workflow: **pull the next Ready backlog row from the Notion queue via MCP, move it into In Progress, research it, review the packet, and write the approved enrichment back into the same row until it reaches Packet Ready**. It is built with **Next.js, Gemini, Playwright, and Notion provider adapters**.

It contains the core application pieces:

- a React chat-style UI (`app/components/ChatUI.tsx`)
- a streaming research API route (`app/api/research/route.ts`)
- a streaming Notion write API route (`app/api/write/route.ts`)
- a Gemini agent loop (`lib/agent.ts`)
- Playwright browsing helpers (`lib/browser.ts`)
- a Notion provider layer (`lib/notion/index.ts`)
- a local Notion MCP transport (`lib/notion-mcp.ts`)

The repository is laid out as a standard Next.js App Router project, so `npm install`, `npm run dev`, and `npm run build` work once your environment variables are configured. The default Notion path now runs through the pinned local `@notionhq/notion-mcp-server` package so the visible workflow starts in the Notion queue instead of treating MCP as compatibility plumbing. A direct Notion API lane remains available only when you intentionally want that alternate execution path.

To quickly crawl the repository and print its current state, run:

```bash
npm run status
```

Add `-- --json` if you want the same information as structured JSON.

## Deployment modes

| Mode | Intended host type | Required env vars | Execution mode | Persistence requirement | Encryption requirement | Supported |
| --- | --- | --- | --- | --- | --- | --- |
| `localhost-operator` | Single trusted workstation | baseline app env only | Detached durable jobs by default, inline only as an explicit fallback | Writable local `.notionmcp-data` if you want resumable behavior | Optional | Yes |
| `remote-private-host` | Single long-lived private Node host | `NOTIONMCP_DEPLOYMENT_MODE`, `APP_ALLOWED_ORIGIN`, `APP_ACCESS_TOKEN`, `PERSISTED_STATE_ENCRYPTION_KEY` | Detached durable jobs only | Writable persisted local storage for jobs, audits, metrics, and request coordination | Required | Yes |

## Unsupported deployment targets

Do not treat this repo as a stateless hobby deploy. The shipped coordination model is not designed for:

- ephemeral serverless hosts that cannot keep detached workers alive
- multi-instance deployments without a shared persistence surface
- remote hosts without writable local state for jobs, audits, and request coordination
- public internet exposure without additional containment, monitoring, and network controls

If your host is intentionally inline-only, set `NOTIONMCP_HOST_DURABILITY=inline-only` and treat that as a reduced-guarantee workstation mode rather than a hidden degraded deployment.

## Research lanes

| Lane | Latency target | Evidence budget | Domain diversity | Source-class balancing | Intended use |
| --- | --- | --- | --- | --- | --- |
| Fast | Lowest latency | Bounded default cap | Best effort within cap | Lightweight | Normal backlog throughput |
| Deep | Higher latency | Expanded cap | Explicit minimums before approval | Enforced more aggressively | High-stakes or ambiguous items |

## Supported queue schema

Required properties:

- `Name`
- `Research Prompt`
- `Status`

Recommended operator fields:

- `Claimed At`
- `Claimed By`
- `Run ID`
- `Last Researched At`
- `Research Summary`
- `Recommended Direction`
- `Competitors`
- `Source Count`
- `Last Run Status`
- `Audit URL`
- `Evidence Block`
- `Confidence Note`

Status values used by the reviewed workflow:

- `Ready`
- `In Progress`
- `Needs Review`
- `Packet Ready`
- `Error`

If optional output fields are missing, the workflow can still run but the write-back surface becomes less inspectable. If required queue fields are missing or incompatible, the route should fail fast and leave a visible operator error rather than silently inventing schema.

## Security boundary

The browser and request layers are a hard part of the product boundary, not a hidden implementation detail. The browser layer only accepts public `http(s)` targets, rejects credentialed URLs, and blocks localhost, private-network, and link-local resolution targets after DNS resolution. The request layer treats remote-private-host mode as opt-in and fails closed unless origin and token controls are configured.

See [docs/security-model.md](docs/security-model.md) for the boundary definition and [docs/operator-runbook.md](docs/operator-runbook.md) for the operator recovery flow.

## File map

- [docs/architecture.md](docs/architecture.md) explains the control plane, persistence model, review/write model, and trust boundaries.
- [docs/decisions/0001-local-mcp-default.md](docs/decisions/0001-local-mcp-default.md) records why `local-mcp` is the canonical queue path.
- [docs/notion-native-integration.md](docs/notion-native-integration.md) lays out the migration from one configured integration token to real Notion OAuth, workspace linking, and sync.
- [docs/operator-runbook.md](docs/operator-runbook.md) covers run, review, recovery, and verification steps.
- [docs/security-model.md](docs/security-model.md) documents browser and request boundary guarantees.

## Stack

- **LLM**: Gemini 2.0 Flash (free via Google AI Studio)
- **Search + browsing**: Serper, Brave, and DuckDuckGo provider support, plus Playwright for page browsing
- **Notion integration**: Local Notion MCP by default, optional direct API alternate lane
- **Frontend**: Next.js 15 with streaming SSE

When the app falls back to DuckDuckGo HTML search, the UI labels that run as degraded mode instead of pretending it still has API-backed search quality.

## Setup

### 1. Clone and install

```bash
git clone https://github.com/CrisisCore-Systems/Notionmcp.git
cd Notionmcp
npm install
# ↑ also runs `playwright install chromium` via postinstall
```

> **Current status:** the app boots with the included App Router structure. The Gemini and Notion features require valid environment variables, and the API routes will return clear setup errors until those are provided.

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where to get it |
| --- | --- |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free, no credit card |
| `SERPER_API_KEY` | Optional. [serper.dev](https://serper.dev) — enables one stable API-backed search provider |
| `BRAVE_SEARCH_API_KEY` | Optional. [search.brave.com](https://search.brave.com/) — enables a second API-backed search provider path |
| `SEARCH_PROVIDERS` | Optional. Comma-separated provider order such as `serper,brave,duckduckgo` |
| `NOTIONMCP_DEPLOYMENT_MODE` | Explicit deployment mode. Leave it at `localhost-operator` for workstation use; set `remote-private-host` only for intentional remote private hosting |
| `APP_ALLOWED_ORIGIN` | Optional. Exact origin to allow when you intentionally expose the API beyond localhost |
| `APP_ACCESS_TOKEN` | Optional. Shared secret required for any non-local API access |
| `APP_RATE_LIMIT_MAX` / `APP_RATE_LIMIT_WINDOW_MS` | Optional remote private-mode rate limiting for API routes |
| `REMOTE_RATE_LIMIT_DIR` / `REMOTE_RATE_LIMIT_RETENTION_DAYS` | Optional persisted directory and retention window for remote-private-host rate-limit state |
| `NOTION_TOKEN` | [notion.so/profile/integrations](https://www.notion.so/profile/integrations) — create internal integration |
| `NOTION_PARENT_PAGE_ID` | Open a Notion page → copy the 32-char ID from the URL |
| `NOTION_API_VERSION` | Optional override. Defaults to the pinned `2025-09-03` Notion API version used by both provider modes |
| `NOTION_PROVIDER` | Optional provider mode. `local-mcp` is the default control-plane path; set `direct-api` only when you intentionally want the alternate write lane |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` / `NOTION_OAUTH_REDIRECT_URI` | Optional Notion public-integration OAuth settings for the linked-workspace flow |
| `NOTION_CONNECTION_DIR` / `NOTION_CONNECTION_RETENTION_DAYS` | Optional persisted directory and retention window for encrypted Notion workspace connection records |
| `NOTION_QUEUE_BINDING_DIR` / `NOTION_QUEUE_BINDING_RETENTION_DAYS` | Optional persisted directory and retention window for encrypted linked-workspace queue bindings |
| `NOTION_MCP_COMMAND` / `NOTION_MCP_ARGS` | Optional local MCP replacement command and JSON-array args |
| `WRITE_AUDIT_DIR` | Optional server-side directory for persisted write audit JSON records |
| `WRITE_AUDIT_RETENTION_DAYS` | Optional retention window before old write-audit JSON files are removed. Defaults to 30 |
| `JOB_STATE_DIR` | Optional server-side directory for persisted research/write job state |
| `JOB_STATE_RETENTION_DAYS` | Optional retention window before old durable-job JSON files are removed. Defaults to 30 |
| `OPERATOR_METRICS_PATH` | Optional file path for persisted operator metrics so counters survive worker restarts |
| `PERSISTED_STATE_ENCRYPTION_KEY` | Optional for localhost, required for any remote private deployment so persisted job/audit state is encrypted at rest |
| `NOTIONMCP_RUN_JOBS_INLINE` | Optional escape hatch for inline debugging. Leave unset for the default detached durable-job mode |
| `NOTIONMCP_HOST_DURABILITY` | Optional host declaration. Set `inline-only` on ephemeral/stateless hosts so localhost mode degrades intentionally and remote private-host mode refuses to boot |

Deployment note: `remote-private-host` is only supported on a long-lived Node host with writable persisted local storage and detached durable jobs enabled. Do not use it on stateless serverless or multi-instance hosts without shared persistence.

**Important**: Your Notion integration must have access to the parent page.
Go to the page in Notion → `...` menu → `Connect to` → select your integration.

By default, `/api/research` and `/api/write` run in **`localhost-operator`** mode and only accept local
requests. Remote API settings are no longer inferred into a deployment mode: if you intentionally deploy the app
for tightly controlled private use, you must set
`NOTIONMCP_DEPLOYMENT_MODE=remote-private-host` together with **all three** of `APP_ALLOWED_ORIGIN`,
`APP_ACCESS_TOKEN`, and `PERSISTED_STATE_ENCRYPTION_KEY`, then send the matching token in either the
`x-app-access-token` header or a `Bearer` token. Cross-origin requests are rejected either way, and the app
now refuses to boot remote private-host mode unless detached durable jobs remain enabled. The built-in UI
includes an optional access-token field for that private remote mode; leave it blank for normal localhost
use. Review drafts can be enabled per browser session from the UI, stay off by default for privacy, and
expire automatically after 7 days when enabled.

If your host cannot actually keep detached workers alive with writable persisted local state, set
`NOTIONMCP_HOST_DURABILITY=inline-only`. In localhost mode the app will intentionally fall back to inline
execution instead of pretending durable workers exist; in `remote-private-host` mode it will refuse to
start because that deployment boundary depends on detached resumable workers plus persisted job/audit state.

The Notion provider layer pins the `Notion-Version` header to `2025-09-03` by default so the app does not
silently drift with ambient API defaults. If you intentionally test a newer Notion API release, set
`NOTION_API_VERSION` explicitly in `.env.local`. Leave `NOTION_PROVIDER` unset for the default MCP
control-plane mode, or set `NOTION_PROVIDER=direct-api` only if you intentionally want the alternate
REST write lane.

If you also configure `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, and `NOTION_OAUTH_REDIRECT_URI`, the landing
page exposes a linked-workspace flow through Notion OAuth. That flow persists an encrypted workspace connection
record, shows the linked workspace in the app shell, and lets the operator browse accessible Notion databases when
setting up the queue. Queue preview, queue claim metadata, backlog lifecycle updates, linked-workspace write
execution, and saved queue bindings now preserve the active connection ID through durable jobs. Creating a brand new
database still depends on the configured `NOTION_PARENT_PAGE_ID` until workspace-scoped parent selection lands.

Every write now also persists a server-side JSON audit record outside transient UI state and returns a
download link from the completion panel. The same completion panel now also links to the persisted durable
job JSON so operators can inspect checkpoints, replayable event history, and the final result/error record as
a first-class verification surface. By default those records live under `.notionmcp-data/write-audits` and
`.notionmcp-data/jobs` in the project root, while operator metrics persist to
`.notionmcp-data/operator-metrics.json`; you can redirect them with `WRITE_AUDIT_DIR`, `JOB_STATE_DIR`, and
`OPERATOR_METRICS_PATH`. The matching API verification endpoints are `/api/write-audits/{auditId}` and `/api/jobs/{jobId}`.
Those verification endpoints now return their own verification contracts in the JSON payload and response headers
so audit artifacts remain inspectable even outside the UI. Remote private-host request rate limiting now also persists
state under `.notionmcp-data/request-rate-limits` by default (or `REMOTE_RATE_LIMIT_DIR`) so it no longer
depends on a single in-memory process, but it still assumes one long-lived host with shared local storage.
Old persisted job and audit JSON files are cleaned up automatically after 30 days by default via
`JOB_STATE_RETENTION_DAYS` and `WRITE_AUDIT_RETENTION_DAYS`. Local-only setups can leave persisted state
unencrypted, but any remote private deployment must set `PERSISTED_STATE_ENCRYPTION_KEY` so those JSON files
stay encrypted at rest.

### Persisted-state encryption key rotation

If you rotate `PERSISTED_STATE_ENCRYPTION_KEY`, existing encrypted files under `.notionmcp-data/jobs`,
`.notionmcp-data/write-audits`, and `.notionmcp-data/request-rate-limits` cannot be decrypted with the new
secret until they are re-encrypted. Drain or stop active jobs first, back up those directories, then either:

- re-encrypt the persisted JSON files with the old key before switching to the new one, or
- delete the old persisted files if you intentionally accept losing resumable state and rate-limit history.

Deploying a new key without one of those steps will strand any already-encrypted persisted state.

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Validation scripts

The repository now exposes the core checks directly:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
```

The automated tests cover request-security rules, durable job persistence, write-payload normalization and
boundary validation, duplicate fingerprinting, retry helpers, the reconnectable SSE stream parser, browser
URL blocking guards, and smoke-level 400-path checks for both API routes.

## Example queue items / fallback prompts

- "Research this backlog item: AI meeting notes assistant for product teams"
- "Research this backlog item: lightweight CRM for solo consultants"
- "Research this backlog item: privacy-first internal wiki for startups"
- "Research this backlog item: customer interview repository with semantic search"
- "Research this backlog item: procurement workspace for growing finance teams"

## Architecture and operations

- [docs/architecture.md](docs/architecture.md)
- [docs/decisions/0001-local-mcp-default.md](docs/decisions/0001-local-mcp-default.md)
- [docs/operator-runbook.md](docs/operator-runbook.md)
- [docs/security-model.md](docs/security-model.md)
- [docs/architecture-overview.svg](docs/architecture-overview.svg)

## Example write audit shape

```json
{
  "status": "complete",
  "providerMode": "direct-api",
  "databaseId": "db_123",
  "resumedFromIndex": 147,
  "nextRowIndex": 300,
  "message": "✅ Added 153 rows to the existing Notion database",
  "auditTrail": {
    "rowsReviewed": 300,
    "rowsAttempted": 153,
    "rowsConfirmedWritten": 153,
    "rowsConfirmedAfterReconciliation": 2,
    "rowsSkippedAsDuplicates": 0,
    "rowsLeftUnresolved": 0
  }
}
```

## Trust artifact surface

The durable write lane now leaves behind two operator-facing verification artifacts:

1. **Write audit JSON** — source set, extraction counts, row outcomes, operation keys, duplicate skips, and unresolved rows
   plus reviewed-row counts and reconciliation markers for ambiguous partial failures
2. **Durable job JSON** — queued/running/complete status, replayable event log, checkpoints, worker heartbeat, final result, and resumable state

That verification surface is visible from the completion panel and persists independently of the browser tab, which is
the main trust differentiator in this repository compared with typical “research agent to Notion” demos.

## Threat model notes for hostile web content

- redirect hops are revalidated as public `http(s)` destinations
- non-HTML responses fail closed before extraction
- evidence is normalized into explicit evidence fields instead of handing semi-raw page blobs to the verifier
- instruction-like and prompt-injection-like page text is stripped line-by-line before downstream model use
- unsupported rows are rejected with explicit reasons instead of being silently repaired into existence

## Known limits

- The job worker is optimized for a private operator deployment and persists state on the local filesystem rather
  than an external queue or database.
- Detached job workers assume a long-lived Node host. If you move to an ephemeral/serverless runtime, you should
  replace the local worker launcher with a platform-native durable execution system.

## Short roadmap

- [x] Ship a runnable Next.js + Gemini + Notion MCP workflow
- [x] Add retry-aware writes, duplicate handling, and write resume support
- [x] Validate per-row provenance and evidence density before approval or write
- [ ] Add richer source reconciliation and side-by-side evidence inspection in the approval UI
- [ ] Add optional export/import flows for saved research batches

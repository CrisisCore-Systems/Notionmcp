# Notion MCP Backlog Desk

**Claim the next Ready item from Notion, research it durably, review it, and write the approved packet back into the same row.**

> **Default path:** Notion queue intake and reviewed writes run through local MCP.
> **Alternate lane:** direct API is available only when you intentionally select it.

![Same Notion row moves from Ready to Packet Ready](docs/architecture-overview.svg)

Notionmcp is a **private, single-operator Notion backlog desk** built around one visible queue workflow:

- **Notion is the queue**
- **MCP is the intake path**
- **the app is the reviewed execution layer**
- **the same row gets enriched and advanced**

The operator-visible outcomes are simple:

- **The run survives disconnects**
- **The row does not get rewritten blindly**
- **You approve before the workspace changes**
- **You can inspect what happened afterward**

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

This repository is a **small runnable Next.js app** for one sharp Notion-native workflow: **pull the next Ready backlog row from the Notion queue via MCP, move it into In Progress, research it, review the packet, and write the approved enrichment back into the same row until it reaches Packet Ready**. It is built with **Next.js, Gemini, Playwright, and Notion provider adapters**, and it is intended as a **private operator tool, not a public SaaS offering**.

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

## How it works

1. **Notion is the queue**: the UI claims the next Ready backlog row from a Notion database via the default local MCP transport (`Status=Ready`, `Research Prompt`, and `Name` by default), immediately moves it to `In Progress`, and records `Claimed At`, `Claimed By`, and `Run ID`
2. **A durable run** is created immediately and persisted under `.notionmcp-data/jobs`, so the same backlog item can survive disconnects and resume cleanly
3. **Gemini 2.0 Flash + Playwright** research the claimed row while planner, extractor, and verifier stay behind the scenes as support layers
4. **The app validates the packet before review**, so the row is not rewritten blindly
5. **You review the packet** while the backlog row sits in `Needs Review`
6. **Approved write-back** enriches the same Notion row and advances it to `Packet Ready`

The UI now exposes two reviewed research lanes:

- **Fast lane** — the current default path with the existing low-latency evidence budget
- **Deep research** — a reviewed mode with higher evidence caps, domain-diversity minimums, and source-class balancing before approval

`/api/research` now also publishes a machine-readable route contract on `GET` so the repo surface and runtime
surface both spell out that fast is the bounded default lane while deep is the explicit wider-source lane.

The write path clamps Notion `title`, `rich_text`, and `url` values to Notion-safe lengths before page
creation so oversized model output cannot fail the whole write.

Each Notion write now uses a deterministic per-row operation key, persists row-level provenance metadata
when the database supports the operator columns, performs a reconciliation pass after ambiguous partial
failures before telling the operator where to resume, and checkpoints the active row pointer continuously
inside the durable job record so reconnects do not restart the append.

After the write completes, the UI gives you a standard `https://www.notion.so/...` link. That link
can be opened in a browser or shared into the Notion app on Android.

### Using it effectively on Android

1. Run your research normally and write the results to Notion.
2. On the success screen, tap **Open updated row** first.
3. If Android keeps the link in your browser instead of jumping into the app, use **Share link** or
   **Copy Android/web link**.
4. Open that same `https://www.notion.so/...` link from the Notion app or from Android's share
   sheet.

## Stack

- **LLM**: Gemini 2.0 Flash (free via Google AI Studio)
- **Search + browsing**: Serper, Brave, and DuckDuckGo provider support, plus Playwright for page browsing
- **Notion integration**: Local Notion MCP by default, optional direct API alternate lane
- **Frontend**: Next.js 15 with streaming SSE

When the app falls back to DuckDuckGo HTML search, the UI now labels that run as degraded mode instead of
silently pretending it still has API-backed search quality.

### Durable job behavior

Both `/api/research` and `/api/write` now create a persisted job record and stream job events in reconnectable
windows. Closing the tab no longer discards the run. When the UI reconnects, it resumes from the same job ID and
replays any missed events from the job log before continuing to stream live output.

### Visible trust outcomes

```text
The run survives disconnects
  ↓
The row does not get rewritten blindly
  ↓
You approve before the workspace changes
  ↓
You can inspect what happened afterward
```

Under the hood, the browser layer labels extracted fields as untrusted evidence, validates redirect hops,
fails closed on non-HTML content types, and strips instruction-like text before the verifier sees it.

### Notion provider modes

`app/api/write/route.ts` now talks to a provider layer under `lib/notion/` instead of binding directly
to the local subprocess transport.

- **`local-mcp` (default)** — use the bundled `@notionhq/notion-mcp-server` subprocess as the default transport for queue intake and reviewed writes
- **`direct-api`** — use the configured operator token against Notion's official REST API when you intentionally want an alternate write lane

The local MCP path is the default because this repo is optimized for a Notion-first operator workflow where the next
unit of work starts in the Notion queue instead of in a blank prompt box. The direct API path stays available, but it
is an alternate lane rather than the architectural spine.

Both `/api/research` and `/api/write` now expose `GET` contracts that mirror this architecture story, while
`/api/jobs/{jobId}` and `/api/write-audits/{auditId}` return persisted verification artifacts plus the contract
metadata that explains what each record contains for operator review and replay.

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
|---|---|
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
| `NOTION_MCP_COMMAND` / `NOTION_MCP_ARGS` | Optional local MCP replacement command and JSON-array args |
| `WRITE_AUDIT_DIR` | Optional server-side directory for persisted write audit JSON records |
| `WRITE_AUDIT_RETENTION_DAYS` | Optional retention window before old write-audit JSON files are removed. Defaults to 30 |
| `JOB_STATE_DIR` | Optional server-side directory for persisted research/write job state |
| `JOB_STATE_RETENTION_DAYS` | Optional retention window before old durable-job JSON files are removed. Defaults to 30 |
| `PERSISTED_STATE_ENCRYPTION_KEY` | Optional for localhost, required for any remote private deployment so persisted job/audit state is encrypted at rest |
| `NOTIONMCP_RUN_JOBS_INLINE` | Optional escape hatch for inline debugging. Leave unset for the default detached durable-job mode |
| `NOTIONMCP_HOST_DURABILITY` | Optional host declaration. Set `inline-only` on ephemeral/stateless hosts so localhost mode degrades intentionally and remote private-host mode refuses to boot |

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

Every write now also persists a server-side JSON audit record outside transient UI state and returns a
download link from the completion panel. The same completion panel now also links to the persisted durable
job JSON so operators can inspect checkpoints, replayable event history, and the final result/error record as
a first-class verification surface. By default those records live under `.notionmcp-data/write-audits` and
`.notionmcp-data/jobs` in the project root, or you can redirect them with `WRITE_AUDIT_DIR` and
`JOB_STATE_DIR`. The matching API verification endpoints are `/api/write-audits/{auditId}` and `/api/jobs/{jobId}`.
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

## Deployment boundary and risk profile

This app is designed first as a **local or tightly controlled private operator tool**, not as an
open public SaaS endpoint. The current guards around request origin, shared-token access, browser
URL vetting, and resumable writes make that local/private mode much safer, but they are not a full
substitute for production-grade containment.

If you choose to deploy it beyond localhost, treat that as a private environment with additional
hardening requirements. The app now models that as an explicit deployment boundary:

- **`localhost-operator`** — local workstation mode; fastest path for a single trusted operator
- **`remote-private-host`** — remote private-host mode; fails closed unless remote access controls,
  persisted-state encryption, and detached durable jobs are all configured

Remote private-host mode still requires these operational controls:

- run it on a long-lived Node host with persistent local storage whenever detached durable jobs are enabled
- keep `APP_ALLOWED_ORIGIN` and `APP_ACCESS_TOKEN` configured together
- add your own edge/network rate limiting, request logging, and operational monitoring
- keep all app instances behind a single shared persistence surface if you rely on the built-in durable jobs
  and request-rate-limit coordination; the shipped coordination remains single-host/private-host oriented
- isolate browser automation so arbitrary page ingestion cannot reach sensitive internal systems
- scope the Notion integration to the smallest practical permission set and parent page

Until those controls exist, the recommended stance is: **local/private tool first, public
deployment only after additional hardening**.

The app now also renders a runtime banner when detached durable jobs are enabled so operators do not mistake
the default deployment posture for a stateless hobby deploy.

## Example queue items / fallback prompts

Recommended backlog properties for the strongest demo are:

- `Status` with `Ready`, `In Progress`, `Needs Review`, `Packet Ready`, and `Error`
- `Claimed At`, `Claimed By`, `Run ID`, and `Last Researched At`
- `Research Summary`, `Recommended Direction`, `Competitors`, `Source Count`, `Last Run Status`, `Audit URL or Job ID`
- `Evidence Block` and `Confidence Note`

- "Research this backlog item: AI meeting notes assistant for product teams"
- "Research this backlog item: lightweight CRM for solo consultants"
- "Research this backlog item: privacy-first internal wiki for startups"
- "Research this backlog item: customer interview repository with semantic search"
- "Research this backlog item: procurement workspace for growing finance teams"

## Architecture

![Queue-first architecture overview](docs/architecture-overview.svg)

- [Architecture doc](docs/architecture.md)
- [SVG source](docs/architecture-overview.svg)

```
Notion backlog row
    ↓ claim via local MCP
Durable research run
    ├── planner
    ├── extractor
    └── verifier
    ↓ review + approve
Approved packet
    ↓ write-back
Same Notion row enriched and advanced
    ↓
Ready → In Progress → Needs Review → Packet Ready
```

## Failure and resume walkthrough

1. Start a research or write run.
2. The route creates a persisted job ID immediately.
3. If the browser tab closes or the SSE window rotates, the detached worker keeps running.
4. Re-open the UI and it reconnects to the active job, replaying missed updates from the persisted event log.
5. For writes, the job checkpoint stores the last confirmed row index, so the next worker resume starts from the
   next unresolved row instead of replaying the whole append.

After completion, the UI exposes both the write-audit JSON and the durable-job JSON so the operator can prove
what evidence was used, what rows were attempted, and where the resumable worker checkpoint ended.

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

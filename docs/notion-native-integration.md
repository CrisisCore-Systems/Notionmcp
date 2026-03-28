# Notion-Native Integration Plan

This app is currently Notion-connected, but not Notion-native.

Today the product model is:

- one server-side Notion integration token or local MCP transport
- one operator-facing workspace
- one queue-first workflow driven by configured database IDs and field names

That is materially different from the experience the product would need in order to feel like a first-class Notion app where an operator signs in with Notion and expects the workspace to stay linked automatically.

## Current limitation

The app does **not yet fully support**:

- user-scoped Notion sign-in that treats the connected Notion identity as the primary operator identity
- multiple cleanly separated workspace connections bound to a specific browser or operator session model
- webhook-driven or scheduled sync to keep the app aligned with changes in Notion
- linked-workspace parent selection for creating new databases without `NOTION_PARENT_PAGE_ID`
- full removal of the remaining env-token fallback paths in local MCP and legacy runtime flows

The current implementation can now run with a linked workspace connection and carry that connection through durable research/write execution, but some legacy flows still exist for env-configured tokens and parent-page setup.

Current status update:

- OAuth workspace linking is implemented.
- The operator UI can now browse accessible databases from the connected workspace and prefill likely queue fields.
- Queue bindings can now be saved per linked workspace and restored into the operator console automatically.
- Active connection IDs now flow through queue preview, queue claim metadata, backlog lifecycle updates, and linked-workspace write execution.
- Creating a brand new database still depends on the configured parent page until workspace-scoped parent selection is implemented.

## What a real Notion-native experience requires

### Phase 1: Notion OAuth and workspace binding

Goal: let an operator connect a Notion workspace instead of pasting a token into `.env.local`.

Implemented work:

- added Notion OAuth start and callback routes
- exchanged authorization codes for workspace-scoped access tokens
- persisted encrypted connection records instead of relying only on `NOTION_TOKEN`
- exposed connection status and discovery APIs for the UI
- surfaced the connected workspace name, workspace icon, bot owner, linked databases, and queue-binding state in the app shell

Impact on current code:

- `lib/notion` now supports connection-scoped execution alongside the legacy env-token path
- durable jobs now carry a connection reference in addition to queue metadata
- write and research jobs can resolve the saved connection record at execution time
- remaining gap: creating new databases still depends on the configured `NOTION_PARENT_PAGE_ID` until linked workspace parent selection lands

### Phase 2: Workspace discovery and database linking

Goal: remove manual queue setup wherever Notion can provide discovery.

Implemented work:

- browse and list accessible databases from the connected workspace
- let the operator pick a queue database from the UI
- inspect database schemas and suggest queue property mappings automatically
- persist queue configuration per workspace connection

Impact on current code:

- queue preview is now part of the linked-workspace flow instead of a purely manual advanced tool
- UI state now supports selected workspace assets and saved queue bindings alongside manual overrides
- remaining gap: database creation still needs linked workspace parent selection before the full queue setup can stay inside the connected Notion workspace model

### Phase 3: Sync and refresh model

Goal: keep the app aligned with Notion changes instead of requiring manual refreshes.

Remaining work:

- add webhook ingestion for the linked workspace if Notion exposes the queue and page events this app needs
- add a fallback polling path for queue databases and written pages that need refresh guarantees when webhook coverage is incomplete
- persist sync cursors, last-seen timestamps, and reconciliation state per linked workspace connection
- surface stale-sync and last-refresh warnings in the UI so operators can tell when queue state may be outdated

Impact on current code:

- there is no webhook or polling-based sync model yet; linked workspace state is still request-driven
- system status does not yet report sync health alongside job health
- queue inspection still shows the latest fetched snapshot rather than freshness or staleness guarantees

### Phase 4: User-scoped experience and operator identity

Goal: make the app feel tied to the logged-in Notion operator instead of a generic backend actor.

Remaining work:

- map the connected Notion workspace and user identity into the UI
- default `claimedBy` to the connected user or workspace member identity
- separate multiple workspace connections cleanly
- harden session management for remote-private-host mode

Impact on current code:

- the UI already shows limited linked-workspace identity details such as workspace name, icon, and bot owner, but that identity is not yet treated as the primary operator model
- queue claim metadata can still fall back to env-based operator names instead of defaulting to the connected Notion user identity
- request security and connection security are still partially coupled in the current remote-private-host flow and need a cleaner separation

## Architectural changes required

The biggest technical changes are not UI changes.

They are:

1. `lib/notion` must finish the shift from one process-global token to fully connection-scoped execution with no linked-workspace fallback gaps.
2. sync infrastructure must persist reconciliation state per linked workspace so refresh and recovery do not depend on manual reloads.
3. connection and session records must stay encrypted at rest and be cleanly separated from operator-facing session security.
4. the UI must finish the shift from preconfigured infrastructure to a real user-scoped connection and freshness model.

## Recommended implementation order

If this product is going to move toward a real Notion-native experience, the order should be:

1. Finish linked-workspace parent selection so queue setup and database creation can stay inside the connected Notion workspace model.
2. Harden the remaining local MCP and legacy provider paths so linked workspaces no longer depend on env-token fallbacks.
3. Add sync and freshness reporting with webhook ingestion where possible and polling where necessary.
4. Add user-scoped operator identity so claim metadata and UI state default to the connected Notion user model.

Doing this in the opposite order would create UI promises that the backend cannot uphold.

## Immediate next slice

The most practical next implementation slice is now:

- let the operator choose a linked workspace parent location instead of relying on `NOTION_PARENT_PAGE_ID`
- harden the remaining local MCP and legacy provider paths so linked workspaces do not need env-token fallback behavior
- keep this slice focused on end-to-end linked-workspace runtime behavior, not sync or user-identity expansion yet

That is the next slice required to turn the linked-workspace surfaces that already exist into fully self-contained runtime behavior.

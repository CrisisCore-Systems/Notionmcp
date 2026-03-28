# ADR 0001: Local MCP is the default queue path

## Status

Accepted.

## Context

This repo models a queue-first operator workflow where the next unit of work begins in Notion rather than in a blank prompt box. The operator needs one visible intake path, one reviewed write path, and one durable verification story that matches the queue state in the same row.

Two transport paths exist:

- `local-mcp`
- `direct-api`

Without an explicit decision record, that split reads like two equal lanes. They are not equal in intent.

## Decision

`local-mcp` is the canonical intake and reviewed write path.

`direct-api` remains available as an intentional alternate lane for cases where the operator explicitly wants the official REST path, but it is not the default control plane and should not shape the primary product story.

## Why

- The queue starts in Notion, so the default control plane should start there too.
- MCP keeps the visible workflow centered on the row lifecycle instead of on an ambient API client.
- The default path should reinforce the product promise: durable, reviewed, inspectable backlog execution against the same Notion row.
- Keeping one canonical path reduces documentation, testing, and operator ambiguity.

## Consequences

- README, architecture docs, and route contracts should present `local-mcp` as the default.
- `direct-api` should be documented as an alternate lane, not as a co-equal architecture spine.
- Remote private-host mode still requires the same deployment and persistence controls regardless of provider mode.

## Recommended use

- Use `local-mcp` for the default workstation and private-host workflow.
- Use `direct-api` only when you intentionally need the alternate REST path and accept that it is outside the default product narrative.

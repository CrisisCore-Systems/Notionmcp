# Operator runbook

This runbook covers the normal reviewed workflow plus the recovery path when durable execution or write reconciliation raises questions.

## Normal lifecycle

1. Start with a Notion row in `Status=Ready`.
2. Claim the row through the UI.
3. Choose the research lane:
   - Fast for routine backlog throughput
   - Deep for wider evidence collection or ambiguous items
4. Let the durable job run until the row reaches `Needs Review`.
5. Review the generated packet.
6. Approve the write only after the packet is acceptable.
7. Confirm the row advances to `Packet Ready`.

## Verification surfaces

- Inspect `/api/jobs/{jobId}` when you need the event log, checkpoint history, or final execution record.
- Inspect `/api/write-audits/{auditId}` when you need the approved payload, provider mode, or write result metadata.

Use the durable job artifact for execution and resume questions. Use the write audit for proof of what was approved and written.

## Resume after disconnect

1. Reopen the UI.
2. Reconnect to the active durable job.
3. Let the UI replay missed events from the durable job log.
4. Confirm the latest checkpoint before retrying any write action.

If the host was running detached durable jobs correctly, disconnecting the browser should not discard the run.

## Partial write ambiguity

1. Stop guessing about row state.
2. Inspect `/api/write-audits/{auditId}` for the last confirmed write metadata.
3. Inspect `/api/jobs/{jobId}` for the last confirmed checkpoint.
4. Resume only from the next unresolved row or unresolved write step.

If the audit and durable job disagree, treat the row as ambiguous until you verify the live Notion state.

## Error state guidance

`Error` means the reviewed workflow did not reach a trustworthy completion state. In practice, that usually means one of these:

- configuration was incomplete
- browsing or evidence collection failed closed
- reconciliation could not prove whether the write completed cleanly
- the host could not satisfy the declared execution mode

Do not clear `Error` by hand without first checking the durable job and write audit artifacts.

## Persistence operations

Default persisted state locations:

- `.notionmcp-data/jobs`
- `.notionmcp-data/write-audits`
- `.notionmcp-data/request-rate-limits`
- `.notionmcp-data/operator-metrics.json`

Operational guidance:

- Back up persisted state before host migration or key rotation.
- Restore the whole persisted-state set together when possible so checkpoints and audits stay aligned.
- Keep retention windows aligned with your operator review horizon.
- Treat missing or corrupted persisted state as a recoverability incident, not as a cosmetic issue.

## Host migration

1. Drain or stop active durable jobs.
2. Back up `.notionmcp-data/`.
3. Move the persisted state to the new host.
4. Reconfigure env vars, including `PERSISTED_STATE_ENCRYPTION_KEY` when required.
5. Start the app and verify readiness before resuming operator work.

## Encryption key rotation

1. Drain or stop active durable jobs.
2. Back up existing persisted state.
3. Re-encrypt existing files with the old key before switching to the new one, or intentionally clear them if you accept losing resumable state.
4. Restart with the new `PERSISTED_STATE_ENCRYPTION_KEY`.

Changing the key without a migration step strands already-encrypted artifacts.

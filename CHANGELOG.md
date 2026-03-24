# Changelog

All notable changes to this project will be documented in this file.

## [0.2.1] - 2026-03-24

### Fixed
- ship the durable-job worker through the runtime `tsx` CLI dependency instead of relying on a dev-only install
- resolve the detached worker command explicitly so durable jobs keep spawning the checked-in `scripts/run-job.ts` entrypoint

### Security
- require `PERSISTED_STATE_ENCRYPTION_KEY` whenever remote private mode is configured with `APP_ALLOWED_ORIGIN` and `APP_ACCESS_TOKEN`
- refuse startup and persisted-state access in remote private mode until the encryption key is configured

### Documentation
- document the remote encryption requirement in `.env.example` and `README.md`
- align the repository release surface with the `v0.2.1` tag

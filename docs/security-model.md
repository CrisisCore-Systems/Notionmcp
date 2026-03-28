# Security model

This repo is optimized for a private operator workflow. The security story is built around reducing accidental trust expansion, not around pretending this is a public SaaS security perimeter.

## Browser boundary

The browser layer is a first-class security boundary.

- Only public `http(s)` targets are eligible for browsing.
- Credentialed URLs are rejected.
- Localhost, private-network, and link-local targets are blocked after resolution.
- Non-HTML content types fail closed.
- Extracted fields are treated as untrusted evidence before verification.

Intent: arbitrary research targets should not become a side door into internal services or local machine surfaces.

Limit: this is still browser automation and should be isolated from sensitive infrastructure when deployed beyond localhost.

## Request boundary

Remote exposure is opt-in.

- `localhost-operator` is the default request posture.
- `remote-private-host` requires explicit origin control and shared-secret access.
- Remote private-host mode also requires persisted-state encryption and detached durable jobs.

Intent: workstations and remote private hosts should not silently collapse into the same trust model.

Limit: origin and token controls are necessary but not sufficient for internet-facing production containment.

## Review boundary

The operator review step is part of the security model.

- Research does not imply write approval.
- Write-back happens only after review.
- Verification artifacts remain available after execution.

Intent: evidence gathering and write execution stay inspectable and interruptible.

## Persistence boundary

Persisted state is part of the trust surface.

- Jobs, write audits, and remote rate-limit coordination are persisted by default.
- Remote private-host mode requires encryption at rest for that persisted state.
- Retention defaults exist, but operators remain responsible for backup, restore, and migration discipline.

Intent: durability should not come from opaque transient memory.

## What this is not

This is not a claim that the repo is ready for unconstrained public multi-tenant deployment. Unsupported or discouraged targets include stateless serverless, multi-instance deployments without shared persistence, and public internet exposure without additional containment and monitoring.

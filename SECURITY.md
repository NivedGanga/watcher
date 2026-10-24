# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Do **not** open a public
issue.

- **Contact:** security@agentwatch.example (placeholder — replace before launch)
- Include: affected component (`cli`, `server`, `integrations`, `spec`), a
  description, steps to reproduce, and impact.
- You will receive an acknowledgement within 72 hours and a status update at
  least every 7 days until resolution.

## Scope

- The hosted service API and routing logic (`server/`)
- The `agentwatch` CLI (`cli/`), including local event storage and credential
  handling (`machine.key`, device secrets)
- The enrollment device flow and push-device credential handling

## Handling

- Credentials (Firebase ID tokens, machine keys, device secrets, FCM tokens)
  are never logged and are stored hashed where the protocol allows.
- Vulnerabilities are fixed on the hosted service first; protocol-affecting
  fixes are reflected in `spec/` with a version decision per
  [`spec/VERSIONING.md`](spec/VERSIONING.md).

Thank you for helping keep AgentWatch users safe.

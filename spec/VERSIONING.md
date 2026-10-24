# Protocol Versioning

## Current version

**1**. Every request to every endpoint carries the header:

```
X-AgentWatch-Protocol: 1
```

This applies to the web app, the CLI (machine endpoints), browser device
endpoints, enrollment endpoints, and `POST /api/jobs/tick`.

## Server behavior

- A request with a missing, empty, or unsupported
  `X-AgentWatch-Protocol` value returns **426** with the standard error
  envelope:

  ```json
  {"error": {"code": "upgrade_required", "message": "Unsupported protocol version"}}
  ```

- The header value is an integer string. There is no minor-version
  negotiation: only major versions exist on the wire.

## Change policy within a version

**Additive only.** Within protocol version 1 the following changes are
allowed without a version bump:

- New endpoints.
- New optional request fields (requests still reject unknown fields per the
  schemas; optional fields are only added to the schema with a rollout —
  see below).
- New response fields. Clients must ignore response fields they do not
  know.
- New enum values where the field is consumed by the server only
  (never for `type`/`kind` values a client must interpret).

The following require a new major version:

- Removing or renaming fields, endpoints, or enum values.
- Changing a field's type or meaning.
- Making a previously optional field required.
- Tightening validation on any field.

## Client behavior

- Clients send `X-AgentWatch-Protocol: 1` on every request.
- Clients must ignore unknown fields in responses and unknown keys in push
  payloads.
- On `426 upgrade_required`, the CLI stops retrying the request (it is not a
  transient error) and tells the user to update the CLI.

## Independent updates

The CLI, server, and web app may be updated at different times. The wire
contract in this directory is the only coordination point: an old CLI must
keep working against a new server, and vice versa, for as long as both speak
protocol version 1.

## Major version transitions

- A new major version gets a new header value (`X-AgentWatch-Protocol: 2`).
- When a new major version is introduced, the server accepts **both** versions
  for at least **90 days** of overlap. During overlap, a request's header
  selects which protocol version answers it.
- After the overlap window, requests for the retired version return `426`
  `upgrade_required`.

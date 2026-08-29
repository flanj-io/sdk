# Flanj — Concepts (engineering overview)

*This is a technical overview for contributors to the public `sdk` / `collector` repos. It intentionally
contains only the engineering model — not product strategy.*

## What Flanj does

Flanj is an integration-reliability tool. It captures the real request/response traffic between a
service and a third-party API it depends on, and validates that live traffic against the provider's
published OpenAPI spec. When the live traffic diverges from the spec (a field changes type, an
enum gains an undocumented value, a webhook stops arriving), that **drift** is surfaced with the exact
evidence — the redacted call that proves it.

## Two planes

- **Local plane (self-hosted, this is the OSS part):** capture, redaction, storage, drift detection, and a
  local UI — all inside the user's own environment. **Raw calls never leave.**
- **Control plane (hosted, separate/closed):** collaboration — when a user *references* a call to flag it,
  a redacted copy is promoted to a durable thread that a provider engineer can open and reply to. The local
  plane only ever pushes outbound to the control plane; nothing peers inbound.

## The components in these public repos

- **`sdk`** — a thin OpenTelemetry (JS) distribution that adds HTTP **request/response body capture** and
  **redaction-at-source**. OTel auto-instrumentation gives spans/metadata but not bodies; the bodies are the
  non-redundant evidence. Redaction happens here, at the call site, **before** anything is stored or sent.
- **`collector`** — an OpenTelemetry Collector distribution (built with `ocb`): receives the SDK's OTLP,
  applies defense-in-depth redaction, runs drift detection near the source, stores redacted calls in a
  local store (a rolling window; embedded by default, or a customer-provided Postgres so multiple
  collector pods can share one store — see the collector's `docs/STORE.md`), and serves a localhost UI.
  Headless and outbound-only apart from that UI.

## Non-negotiables (why the code is shaped the way it is)

1. **Redaction at source, before store or transmit.** A redaction floor — composed, hardened validators
   (Luhn-gated PAN, email, IBAN, phone) behind our own interface, with deep traversal of nested bodies and
   base64 decode-then-scan; local, zero external calls — is mandatory and runs before a body is ever attached
   to a span/log or written to disk. This is defense in depth — the collector re-applies the identical floor
   in Go, idempotently, and a shared fixture suite keeps the two byte-for-byte in parity. See `REDACTION.md`.
2. **Raw calls never leave the local environment.** Only a *referenced* (redacted) call is promoted to the
   control plane, and only when a human flags it.
3. **Outbound-only collector.** No inbound surface; the collector only pushes to the control plane.
4. **Technical adherence only.** Drift detection validates fields/types/shapes/enums — never business or
   economic correctness (prices, fees, FX), which are legitimately variable.

## The contract

Cross-component wire formats (the OTLP attribute convention, the redacted-call record, the redaction floor)
are pinned in `contracts/` (vendored from a canonical source). The redaction floor is governed by golden
fixture files (scalar vectors + the cross-language parity battery) that all implementations conform to.
Changes to any wire format go through the contract first.

# @vinifera/sdk

A thin [OpenTelemetry](https://opentelemetry.io/) distribution for **integration-reliability capture**: it
records the request/response **bodies** of the HTTP calls your service makes to — and receives from — third-party APIs, **redacts
sensitive data at the source**, and exports them (over OTLP) to a Vinifera collector for drift detection.

OTel auto-instrumentation gives you spans and metadata; this SDK adds the payloads — the evidence you need to
prove a provider changed their API out from under you — while guaranteeing that raw PANs/PII are redacted
before anything is stored or leaves your process.

- **Redaction-at-source**, before capture is stored or transmitted (PAN via Luhn, PII, secrets).
- **Body capture** on the `http`/`https` client (egress) and server (ingress) paths, size-capped and content-type gated.
- **MCP client instrumentation** (`instrumentMcpClient`) — wraps the MCP `Client` (both `@modelcontextprotocol` package lines, optional peers, byte-identical pass-through): `tools/list` snapshots become the server's self-delivering contract and `tools/call` bodies are captured and redacted like any other call.
- Emits a stable `vinifera.*` OTLP convention consumed by the [collector](https://github.com/vinifera-io/collector).

**Supported:** REST/HTTP integrations — live request/response validated against the provider's OpenAPI.
**Supported:** MCP tools — tool-definition drift and result-vs-`outputSchema` mismatch, flagged to the server operator with evidence.
**Roadmap:** webhooks (received-webhook contract drift; missing-webhook detection under design).

Also publishes **`@vinifera/redaction-patterns`**, the standalone redaction floor.

**We turn a detection into something you can act on with your vendor.**
Open-source SDK (Apache-2.0) and source-available collector (ELv2); hosted network layer.

## Status

Pre-release (v0). See [docs/CONCEPTS.md](docs/CONCEPTS.md) for the engineering model and [CLAUDE.md](CLAUDE.md)
for the repo map.

## License

[Apache-2.0](LICENSE). Contributions require a DCO sign-off — see [CONTRIBUTING.md](CONTRIBUTING.md).

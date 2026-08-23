# @vinifera/sdk

A thin [OpenTelemetry](https://opentelemetry.io/) distribution for **integration-reliability capture**: it
records the request/response **bodies** of the HTTP calls your service makes to — and receives from — third-party APIs, **redacts
sensitive data at the source**, and exports them (over OTLP) to a Vinifera collector for drift detection.

OTel auto-instrumentation gives you spans and metadata; this SDK adds the payloads — the evidence you need to
prove a provider changed their API out from under you — while guaranteeing that raw PANs/PII are redacted
before anything is stored or leaves your process.

- **Redaction-at-source**, before capture is stored or transmitted (PAN via Luhn, PII, secrets).
- **Body capture** on the `http`/`https` client (egress) and server (ingress) paths, size-capped and content-type gated.
- Emits a stable `vinifera.*` OTLP convention consumed by the [collector](https://github.com/vinifera-io/collector).

Also publishes **`@vinifera/redaction-patterns`**, the standalone redaction floor.

Open-source SDK (Apache-2.0) and source-available collector (ELv2); hosted network layer.

## Status

Pre-release (v0). See [docs/CONCEPTS.md](docs/CONCEPTS.md) for the engineering model and [CLAUDE.md](CLAUDE.md)
for the repo map.

## License

[Apache-2.0](LICENSE). Contributions require a DCO sign-off — see [CONTRIBUTING.md](CONTRIBUTING.md).

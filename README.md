# @flanj/sdk

A thin [OpenTelemetry](https://opentelemetry.io/) distribution for **integration-reliability capture**: it
records the request/response **bodies** of the HTTP calls your service makes to — and receives from — third-party APIs, **redacts
sensitive data at the source**, and exports them (over OTLP) to a Flanj collector for drift detection.

## Quick start

Needs Node `^18.19.0 || >=20.6.0` and a running [Flanj collector](https://github.com/flanj-io/collector).

```bash
npm install @flanj/sdk        # or: yarn add @flanj/sdk
```

```bash
FLANJ_INTEGRATION_ID=acme-payments \
FLANJ_OTLP_ENDPOINT=http://localhost:4318/v1/logs \
node -r @flanj/sdk/register app.js
```

That is the whole integration — no source change. The preload prints one line naming the endpoint and
integration id, then every `node:http`/`node:https` call is captured, redacted and exported.

**Verify** — after your app has made at least one call:

```bash
curl -s http://127.0.0.1:5335/api/health
```

then open <http://127.0.0.1:5335> and look at the **Traffic** tab: your call should be there, redacted.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLANJ_INTEGRATION_ID` | `unknown-integration` | Names the integration, emitted as `flanj.integration`. Set it. |
| `FLANJ_OTLP_ENDPOINT` | `http://localhost:4318/v1/logs` | OTLP/HTTP **logs** endpoint — note the `/v1/logs` path. A bare base URL (`http://localhost:4318`) is normalized to it; any other path is used verbatim. |
| `OTEL_SERVICE_NAME` | `flanj-consumer` | The `service.name` resource attribute. |
| `FLANJ_BODY_CAP_BYTES` | `16384` | Per-body capture cap, in bytes. |
| `FLANJ_IGNORE_URLS` | — | Comma-separated substrings; a matching URL is never captured. The exporter's own host is always ignored. |
| `FLANJ_TRUSTED_PROXIES` | — | Comma-separated IPs / CIDR blocks of the reverse proxies or load balancers in front of your service (`10.0.0.5,fd00::5`). List the proxies themselves, not your whole network: every address in the set is skipped when walking the chain, so a caller inside it could still pick its own edge class. Inbound calls are classified by their **socket peer**; `X-Forwarded-For` is honoured only from these peers, and the caller is then the hop your proxy appended (the rightmost one that is not itself a trusted proxy), never the leftmost. Unset, the header is ignored — so **behind a proxy every inbound call classifies internal (metadata-only) until you set this**. An entry that is not an IP or CIDR fails `start()`. |
| `FLANJ_FLUSH_TIMEOUT_MS` | `5000` | Upper bound on the exit/`SIGTERM` flush, so a wedged collector can never make your process unkillable. |
| `FLANJ_QUIET` | — | `1` silences the one-line startup notice. |

`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and `OTEL_EXPORTER_OTLP_ENDPOINT` are honoured as fallbacks, in that
order, if `FLANJ_OTLP_ENDPOINT` is unset — so a host already configured for OTLP needs nothing new.

### ESM, CJS, and shutdown

`-r @flanj/sdk/register` works for **both** CommonJS and ESM entrypoints; `node --import @flanj/sdk/register`
works too. From code, a single side-effecting import at the very top of your entrypoint is equivalent:

```js
import '@flanj/sdk/register';   // ESM
require('@flanj/sdk/register'); // CJS
```

The register entry flushes on `beforeExit` and on `SIGTERM`/`SIGINT` (then re-raises the signal), so a
one-shot script and a pod's last batch both deliver. If you start the SDK yourself instead, you own that:

```js
const { start } = require('@flanj/sdk');
const flanj = start({ integration: 'acme-payments' });
// ... your app ...
await flanj.shutdown(); // or flanj.flush() — records are batched, so this is not optional
```

## What is captured

**Captured** — any client that goes through Node's core `node:http` / `node:https`, which is most of them:
`axios`, `got`, `node-fetch`, `superagent`, and `http.request`/`https.request` used directly. Both
directions: calls your service **makes** (egress) and calls it **receives** (ingress).

**Not captured yet** — anything that bypasses `node:http`:

- **Global `fetch()` and `undici`.** Node 18+ `fetch` is undici, which has its own socket path. This is
  silent: you get zero rows and no warning, while an `axios` call beside it shows up normally. If your
  service uses `fetch`, this SDK will not see those calls yet.
- **`node:http2`.**
- **Webhooks you receive** — see Roadmap below.

Bodies are captured only on **external** edges and only for JSON/text/form content types; internal edges
are metadata-only. See [REDACTION.md](REDACTION.md) for what is redacted and how.

**Inbound calls behind a reverse proxy.** The caller of an inbound call is its socket peer — behind a load
balancer that is the balancer's private address, so every inbound edge classifies **internal** and no bodies
are captured. `X-Forwarded-For` is client-controlled, so the SDK does not believe it by default: set
`FLANJ_TRUSTED_PROXIES` to your proxies' addresses (or `trustedProxies` in `start()`) and the header is
honoured from exactly those peers, taking the hop your proxy appended rather than whatever the client sent.

## Also in this distribution

OTel auto-instrumentation gives you spans and metadata; this SDK adds the payloads — the evidence you need to
prove a provider changed their API out from under you — while guaranteeing that raw PANs/PII are redacted
before anything is stored or leaves your process.

- **Redaction-at-source**, before capture is stored or transmitted (PAN via Luhn, PII, secrets).
- **Body capture** on the `http`/`https` client (egress) and server (ingress) paths, size-capped and content-type gated.
- **MCP client instrumentation** (`instrumentMcpClient`) — wraps the MCP `Client` (both `@modelcontextprotocol` package lines, optional peers, byte-identical pass-through): `tools/list` snapshots become the server's self-delivering contract and `tools/call` bodies are captured and redacted like any other call.
- Emits a stable `flanj.*` OTLP convention consumed by the [collector](https://github.com/flanj-io/collector).

**Supported:** REST/HTTP integrations — live request/response validated against the provider's OpenAPI.
**Supported:** MCP tools — tool-definition drift and result-vs-`outputSchema` mismatch, flagged to the server operator with evidence.
**Roadmap:** webhooks (received-webhook contract drift; missing-webhook detection under design).

Also publishes **`@flanj/redaction-patterns`**, the standalone redaction floor.

**We turn a detection into something you can act on with your vendor.**
Open-source SDK (Apache-2.0) and source-available collector (ELv2); hosted network layer.

## Status

Pre-release (v0). See [docs/CONCEPTS.md](docs/CONCEPTS.md) for the engineering model and [CLAUDE.md](CLAUDE.md)
for the repo map.

## License

[Apache-2.0](LICENSE). Contributions require a DCO sign-off — see [CONTRIBUTING.md](CONTRIBUTING.md).

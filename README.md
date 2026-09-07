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
| `FLANJ_FLUSH_TIMEOUT_MS` | `5000` | Upper bound on the exit/`SIGTERM` flush, so a wedged collector can never make your process unkillable. |
| `FLANJ_QUIET` | — | `1` silences the one-line startup notice. |

`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and `OTEL_EXPORTER_OTLP_ENDPOINT` are honoured as fallbacks, in that
order, if `FLANJ_OTLP_ENDPOINT` is unset — so a host already configured for OTLP needs nothing new.

### ESM, CJS, and shutdown

The preload works for **both** CommonJS and ESM entrypoints, and is the recommended form because it runs
before any of your modules load:

```bash
node -r @flanj/sdk/register app.js          # CJS or ESM entrypoint
node --import @flanj/sdk/register app.mjs   # the ESM-native flag; equivalent
```

From code, a single side-effecting import is equivalent — put it **first** in your entrypoint:

```js
import '@flanj/sdk/register';   // ESM
require('@flanj/sdk/register'); // CJS
```

Every way of reaching `node:http`/`node:https` is captured: `http.request(...)` on a `require`d or
default-imported module, an `import * as http` namespace, and ESM named imports —
`import { request, get } from 'node:http'` — **including bindings a module took before the SDK started**
(the SDK re-syncs Node's builtin ESM bindings whenever it patches or unpatches). What can never be captured
is a call made before the SDK started, or a function copied into a local variable before then
(`const r = http.request`), which no patch can reach — hence the preload.

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

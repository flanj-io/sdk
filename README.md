<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/flanj-io/sdk/main/docs/brand/flanj-lockup-dark.svg">
  <img alt="Flanj" height="48" src="https://raw.githubusercontent.com/flanj-io/sdk/main/docs/brand/flanj-lockup.svg">
</picture>

# @flanj/sdk

Nothing threw. Nothing 500'd. The response was 200 OK and a field was renamed. Your integration
didn't break — it started being wrong, and every tool that waits for an error is blind to it.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm: @flanj/sdk](https://img.shields.io/npm/v/@flanj/sdk.svg)](https://www.npmjs.com/package/@flanj/sdk)
[![ci](https://github.com/flanj-io/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/flanj-io/sdk/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@flanj/sdk.svg)](package.json)

`@flanj/sdk` is a thin [OpenTelemetry](https://opentelemetry.io/) distribution for Node. It records the
request and response bodies of the HTTP calls your service makes to third-party APIs, and of the calls it
receives, redacts sensitive data at the source, and exports the redacted records over OTLP to a Flanj
collector, which checks them against the provider's contract and flags drift.

**Trust posture.** Capture is out of band: the SDK tees the bytes your app already sends and receives, and
never proxies, rewrites, delays or blocks a call. Redaction runs in your process, before a body is stored or
exported, and the raw buffer is dropped the moment the redacted string exists. Redacted records go only to a
collector you run in your own environment; bodies never leave it. See [REDACTION.md](REDACTION.md) for the
floor and how it is held identical across languages.

## Quick start

Needs Node `^20.16.0 || >=22.3.0` and a running Flanj collector, started with the collector README's
[Run it on a laptop](https://github.com/flanj-io/collector#run-it-on-a-laptop) block. Use that command as
written: the collector's UI binds container loopback by design, so it is reached through the small sidecar
that block includes, and a plain `docker run -p 5335:5335` publishes nothing.
The SDK patches core `node:http` through `process.getBuiltinModule`, which landed in Node 20.16.0 and 22.3.0;
on anything older `start()` throws one line naming the requirement rather than capturing nothing.

```bash
npm install @flanj/sdk        # or: yarn add @flanj/sdk
```

```bash
FLANJ_INTEGRATION_ID=acme-shipping \
FLANJ_OTLP_ENDPOINT=http://localhost:4318/v1/logs \
node -r @flanj/sdk/register app.js
```

That is the whole integration; no source change. The preload prints one line naming the endpoint and
integration id, then every `node:http`/`node:https` call is captured, redacted and exported.

**Verify** — after your app has made at least one call, and assuming the collector was started with the
[Run it on a laptop](https://github.com/flanj-io/collector#run-it-on-a-laptop) command including its UI
sidecar:

```bash
curl -s http://127.0.0.1:5335/api/health
```

then open <http://127.0.0.1:5335> and look at the **Traffic** tab: your call should be there, redacted.

If that `curl` answers `Failed to connect`, the SDK is not what failed: the collector's UI is loopback-only
inside its container and nothing is forwarding to it. Re-run the collector with that block's sidecar. Ingest
on `:4318` is a separate, ordinary published port and works either way.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLANJ_INTEGRATION_ID` | `unknown-integration` | Names the integration, emitted as `flanj.integration`. Set it. |
| `FLANJ_OTLP_ENDPOINT` | `http://localhost:4318/v1/logs` | OTLP/HTTP **logs** endpoint, with the `/v1/logs` path. A bare base URL (`http://localhost:4318`) is normalized to it; any other path is used verbatim. |
| `OTEL_SERVICE_NAME` | `flanj-consumer` | The `service.name` resource attribute. |
| `FLANJ_BODY_CAP_BYTES` | `16384` | Per-body capture cap, in bytes. |
| `FLANJ_IGNORE_URLS` | — | Comma-separated substrings; a matching URL is never captured. The exporter's own host is always ignored. |
| `FLANJ_TRUSTED_PROXIES` | — | Comma-separated IPs / CIDR blocks of the reverse proxies or load balancers in front of your service (`10.0.0.5,fd00::5`). List the proxies themselves, not your whole network: every address in the set is skipped when walking the chain, so a caller inside it could still pick its own edge class. Inbound calls are classified by their **socket peer**; `X-Forwarded-For` is honoured only from these peers, and the caller is then the hop your proxy appended (the rightmost one that is not itself a trusted proxy), never the leftmost. Unset, the header is ignored, so **behind a proxy every inbound call classifies internal (metadata-only) until you set this**. An entry that is not an IP or CIDR fails `start()`. |
| `FLANJ_FLUSH_TIMEOUT_MS` | `5000` | Upper bound on the exit/`SIGTERM` flush, so a wedged collector can never make your process unkillable. |
| `FLANJ_QUIET` | — | `1` silences the one-line startup notice. |

`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and `OTEL_EXPORTER_OTLP_ENDPOINT` are honoured as fallbacks, in that
order, if `FLANJ_OTLP_ENDPOINT` is unset, so a host already configured for OTLP needs nothing new.

### ESM, CJS, and shutdown

The preload works for both CommonJS and ESM entrypoints, and is the recommended form because it runs
before any of your modules load:

```bash
node -r @flanj/sdk/register app.js          # CJS or ESM entrypoint
node --import @flanj/sdk/register app.mjs   # the ESM-native flag; equivalent
```

From code, a single side-effecting import is equivalent. Put it first in your entrypoint:

```js
import '@flanj/sdk/register';   // ESM
require('@flanj/sdk/register'); // CJS
```

Every way of reaching `node:http`/`node:https` is captured: `http.request(...)` on a `require`d or
default-imported module, an `import * as http` namespace, and ESM named imports —
`import { request, get } from 'node:http'` — including bindings a module took before the SDK started
(the SDK re-syncs Node's builtin ESM bindings whenever it patches or unpatches). What can never be captured
is a call made before the SDK started, or a function copied into a local variable before then
(`const r = http.request`), which no patch can reach; hence the preload. One caveat: under an ESM
loader hook that rewrites `node:http` (OpenTelemetry's import-in-the-middle, for instance), a named
import binds to the hook's copy, which the re-sync cannot reach. Use the preload there, after the hook.

The register entry flushes on `beforeExit` and on `SIGTERM`/`SIGINT` (then re-raises the signal), so a
one-shot script and a pod's last batch both deliver. If you start the SDK yourself instead, you own that:

```js
const { start } = require('@flanj/sdk');
const flanj = start({ integration: 'acme-shipping' });
// ... your app ...
await flanj.shutdown(); // or flanj.flush() — records are batched, so this is not optional
```

### Running next to OpenTelemetry

This SDK is built to run beside your existing OpenTelemetry setup, not instead of it. OTel's
`@opentelemetry/instrumentation-http` gives you spans and metadata; Flanj adds the request and response
payloads. Both patch the same functions on `node:http`, so Flanj wraps on top of whatever is already
installed rather than replacing it, and it never installs OTel's require-in-the-middle module hooks, which
would stop OTel's own patch from running.

Either registration order works, and both are covered by a real-process test
(`test/integration/otel-coexistence.spec.ts`):

```js
// OTel first, then Flanj — or the other way round. Both keep their spans and their rows.
registerInstrumentations({ instrumentations: [new HttpInstrumentation()] });
require('@flanj/sdk/register');
```

One ordering rule, and only when you use OTel's ESM loader hook: the hook first, your OTel setup next,
the Flanj preload last.

```bash
node --import @opentelemetry/instrumentation/hook.mjs \
     --import ./otel-setup.mjs \
     --import @flanj/sdk/register \
     app.mjs
```

Known interaction: calling `disable()` on OTel's http instrumentation while Flanj is loaded removes the
outermost wrapper, which may be Flanj's (that is `shimmer`'s behaviour, shared by every library that
patches this way). Capture comes back with `handle.instrumentation.disable()` followed by `enable()`.

## What is captured

**Captured** — any client that goes through Node's core `node:http` / `node:https`, which is most of them:
`axios`, `got`, `node-fetch`, `superagent`, and `http.request`/`https.request` used directly. Both
directions: calls your service makes (egress) and calls it receives (ingress). Capture is a passive tee on
the bytes already in flight; the call itself is untouched.

**Not captured yet** — anything that bypasses `node:http`:

- **Global `fetch()` and `undici`.** Node 18+ `fetch` is undici, which has its own socket path. This is
  silent: you get zero rows and no warning, while an `axios` call beside it shows up normally. If your
  service uses `fetch`, this SDK will not see those calls yet.
- **`node:http2`.**
- **Webhooks you receive** — see Roadmap below.

Bodies are captured only on external edges and only for JSON, text and form content types; JSON includes
every RFC 6839 `+json` media type (`application/problem+json`, `application/vnd.api+json`, `application/hal+json`,
and so on). Internal edges are metadata-only. Every captured body is redacted in your process before it is
stored or exported, and the raw buffer is dropped; see [REDACTION.md](REDACTION.md) for what is redacted and how.

**Inbound calls behind a reverse proxy.** The caller of an inbound call is its socket peer. Behind a load
balancer that is the balancer's private address, so every inbound edge classifies internal and no bodies
are captured. `X-Forwarded-For` is client-controlled, so the SDK does not believe it by default: set
`FLANJ_TRUSTED_PROXIES` to your proxies' addresses (or `trustedProxies` in `start()`) and the header is
honoured from exactly those peers, taking the hop your proxy appended rather than whatever the client sent.

## Also in this distribution

OTel auto-instrumentation gives you spans and metadata; this SDK adds the payloads, which are the evidence
you need to show a provider changed their API out from under you, while guaranteeing that card numbers,
personal data and secrets are redacted before anything is stored or leaves your process.

- **Redaction at source**, before capture is stored or transmitted (card numbers via Luhn, personal data, secrets).
- **Body capture** on the `http`/`https` client (egress) and server (ingress) paths, size-capped and content-type gated.
- **MCP client instrumentation** (`instrumentMcpClient`) wraps the MCP `Client` (both `@modelcontextprotocol` package lines, optional peers, byte-identical pass-through): `tools/list` snapshots become the server's self-delivering contract and `tools/call` bodies are captured and redacted like any other call.
- Emits a stable `flanj.*` OTLP convention consumed by the [collector](https://github.com/flanj-io/collector).

### MCP clients: the contract arrives with the traffic

REST drift detection needs a spec somebody published and kept accurate. MCP servers publish their
contract on every single call — `tools/list` **is** the spec. So `instrumentMcpClient` gives the
collector a baseline from the first call your agent makes, for every MCP server it touches, with
nothing to configure and nothing to upload: the observed `tools/list` is forwarded as a contract
snapshot, versioned by content hash, and every later `tools/call` is checked against it.

That is not a convenience difference. "Nobody publishes an accurate OpenAPI spec" is the strongest
practical objection to the REST half of this, and it does not apply to MCP at all — which matters
most for agents, the most drift-fragile API consumers anyone has built: an agent reads a tool's
description to decide what to do, so a description that changes under it changes what it does, and
nothing anywhere logs an error.

The wrapper is out of band like every other capture path here: it wraps `Client` from both
`@modelcontextprotocol` package lines as optional peers, passes results through byte-identical, and
never delays or rewrites a call.


**Supported:** REST/HTTP integrations — live request and response validated against the provider's OpenAPI document.
**Supported:** MCP tools — tool-definition drift and result-vs-`outputSchema` mismatch, flagged to the server operator with evidence.
**Roadmap:** webhooks (received-webhook contract drift; missing-webhook detection under design).

**Languages.** Node / TypeScript — **supported**: this package, HTTP egress and ingress plus the MCP
client. Python — **early**, MCP client only, with no HTTP body capture; there is no `node:http` choke
point to port, and for an agent shop with no REST integration to instrument, MCP-only is a complete
product rather than a partial SDK. A language is called *supported* only once the whole loop runs on
it end to end in our own e2e harness, with that lane's assertions green — until then it says early,
here and everywhere else.

**Where this stops, said out loud.** Global `fetch`/undici is **not** captured (see *What is
captured*). A REST provider needs a spec somebody published; an MCP server needs none. A call the
collector cannot check against a contract is captured and reported as **not validated**, never as
conforming.

Also publishes [`@flanj/redaction-patterns`](packages/redaction-patterns/README.md), the standalone redaction floor.

Flanj turns a detection into something you can act on with the other team. The SDK is open source under
Apache-2.0; the [collector](https://github.com/flanj-io/collector) is source-available under the Elastic
License 2.0; the network layer that carries a flagged finding between the two teams is hosted.

## Status

Pre-release (v0). See [docs/CONCEPTS.md](docs/CONCEPTS.md) for the engineering model and [CLAUDE.md](CLAUDE.md)
for the repo map.

## License

[Apache-2.0](LICENSE). Contributions require a DCO sign-off; see [CONTRIBUTING.md](CONTRIBUTING.md).

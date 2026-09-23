<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/flanj-io/sdk/main/docs/brand/flanj-lockup-dark.svg">
  <img alt="Flanj" height="48" src="https://raw.githubusercontent.com/flanj-io/sdk/main/docs/brand/flanj-lockup.svg">
</picture>

# @flanj/sdk

**Your integration didn't break. It started being wrong.**

Every call succeeded. That's why nothing caught it.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm: @flanj/sdk](https://img.shields.io/npm/v/@flanj/sdk.svg)](https://www.npmjs.com/package/@flanj/sdk)
[![ci](https://github.com/flanj-io/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/flanj-io/sdk/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@flanj/sdk.svg)](package.json)

[flanj.io](https://flanj.io)

`@flanj/sdk` is a thin [OpenTelemetry](https://opentelemetry.io/) distribution for Node. It records the
request and response bodies of the HTTP calls your service makes to third-party APIs and of the calls it
receives, and the `tools/list` catalogue and `tools/call` traffic of every MCP server your agent talks to.
It redacts sensitive data at the source, then exports the redacted records over OTLP to a Flanj collector,
which checks them against the provider's contract and flags drift.

**Trust posture.** Capture is out of band: the SDK tees the bytes your app already sends and receives, and
never proxies, rewrites, delays or blocks a call. Redaction runs in your process, before a body is stored or
exported, and the raw buffer is dropped the moment the redacted string exists. Redacted records go only to a
collector you run in your own environment; bodies never leave it. See [REDACTION.md](REDACTION.md) for the
floor and how it is held identical across languages.

## Quick start

Needs Node `^20.16.0 || >=22.3.0` and a running Flanj collector: [Run it on
Kubernetes](https://github.com/flanj-io/collector#run-it-on-kubernetes) — the preferred way to deploy one —
or [Run it with Docker](https://github.com/flanj-io/collector#run-it-with-docker).
The SDK patches core `node:http` through `process.getBuiltinModule`, which landed in Node 20.16.0 and 22.3.0;
on anything older `start()` throws one line naming the requirement rather than capturing nothing.

```bash
npm install @flanj/sdk        # or: yarn add @flanj/sdk
```

The Docker collector already listens on the SDK's default endpoint, `http://localhost:4318/v1/logs`, so
there is nothing to point anywhere:

```bash
node -r @flanj/sdk/register app.js
```

That is the whole integration; no source change. `node:http`/`node:https` — and everything built on them
(`axios`, `got`, `node-fetch`, `superagent`) — are captured, and so is global `fetch()` (Node's bundled
undici), which the OpenAI and Anthropic SDKs, the Vercel AI SDK and the MCP HTTP transport call. Two `fetch()`
edges stay uncaptured, silently: a call given its own `dispatcher`, and a library that swaps `globalThis.fetch`
for another implementation (see [What is captured](#what-is-captured)). The preload starts the OTLP pipeline,
flushes on exit, and switches on **both** capture paths: every `node:http`/`node:https` and `fetch()` call,
and — when an MCP client package is installed — every MCP client your app constructs. It prints one line naming the endpoint, the resolved
service name (defaulting to your app's own `package.json` name — see [Configuration](#configuration)) and
what it is capturing (`FLANJ_QUIET=1` silences it). It is the counterpart of the Python SDK's
`import flanj.register`.

### On Kubernetes

The chart installs a fixed-name front Service, so the address below is right for every install that used
the chart README's command. Set it, and the preload, on your **own** workload — not your shell — because
the SDK runs in the app's pod, where `localhost` is not the collector, and `NODE_OPTIONS` is the preload
without editing the image's `command`:

```yaml
env:
  - name: FLANJ_OTLP_ENDPOINT
    value: http://flanj-collector.flanj:4318/v1/logs
  - name: NODE_OPTIONS
    value: "--require @flanj/sdk/register"
```

The chart also renders `ConfigMap/flanj-endpoint` for teams that prefer `envFrom` to inlining the
variable — a pod can only reference a ConfigMap in its own namespace, so the chart has to be told which
namespaces to render it into. See the [chart
README](https://github.com/flanj-io/collector/tree/main/charts/flanj-collector).

**Verify** — after your app has made at least one call:

```bash
curl -s http://127.0.0.1:5335/api/health
```

then open <http://127.0.0.1:5335> and look at the **Traffic** tab: your call should be there, redacted. On
Kubernetes the UI is not published outside the cluster; port-forward it first, in its own terminal:

```bash
kubectl -n flanj port-forward sts/flanj-flanj-collector-store 5335:5335
```

If that `curl` answers `Failed to connect`: on Docker, `docker compose up -d` already starts the UI bridge
as part of the stack, so check it is still running; on Kubernetes, the port-forward above must stay running
in its own terminal. Ingest on `:4318` is a separate, ordinary published port and works either way.

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

Global `fetch()` needs none of that. The SDK composes a capture layer onto undici's global dispatcher, which
every `fetch()` reads when it is called, so it does not matter how or when your code reached `fetch`. The
layer stacks on a global dispatcher your app installed before the SDK started (a proxy agent, say); one
installed after the SDK started replaces it, and those calls are not captured.

Both MCP client packages ship a CommonJS build and an ESM build, which are two different `Client` classes
at runtime. The preload patches both, so it does not matter which one your app reaches for.

The register entry flushes on `beforeExit` and on `SIGTERM`/`SIGINT` (then re-raises the signal), so a
one-shot script and a pod's last batch both deliver.

**`process.exit()` skips it.** `beforeExit` only fires when the event loop drains on its own; calling
`process.exit()` — the natural last line of a one-shot script — ends the process before that happens, so the
flush never runs. Nothing catches it: the startup line still prints, the process still exits `0`, and the
batch is silently dropped. Fix it either way: let the process exit on its own instead of calling
`process.exit()`, or, if you start the SDK yourself, `await flanj.shutdown()` (or `flanj.flush()`)
immediately before you call it.

If you start the SDK yourself instead, you own that:

```js
const { start } = require('@flanj/sdk');
const flanj = start({ serviceName: 'checkout' });
// ... your app ...
await flanj.shutdown(); // or flanj.flush() — records are batched, so this is not optional
```

### MCP quick start

Nothing is configured per server. With the preload loaded and either `@modelcontextprotocol` package
installed, an ordinary client is already captured:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const client = new Client({ name: 'acme-agent', version: '1.0.0' });
await client.connect(transport);
await client.listTools();                                              // -> a contract snapshot
await client.callTool({ name: 'get_balance', arguments: { id: 'x' } }); // -> a captured, redacted call
```

**For each `tools/call`:** the arguments as the request body; `structuredContent` — else the `content[]`
text — as the response body; the outcome (`isError`); the server's identity from the result's `_meta`; and
the JSON-RPC request id your client generated, labelled as client-generated. A call the server **rejected**
(a JSON-RPC error rather than a result with `isError`) also records the error's code. A Tasks handle
(`tasks/get`) is recorded as an envelope with **no body**, so nothing models the envelope as the tool's own
output shape.

**For each complete `tools/list`:** the server's own declared schemas, verbatim, never re-inferred. The
catalogue is refetched and re-snapshotted on `notifications/tools/list_changed` (`refetchOnListChanged`,
on by default), so a server that changes its tools mid-session is caught when it does.

**For a server your app launched over stdio:** how it was launched (`npx @stripe/mcp@0.2.1 …`) — the command
and its arguments only, each floor-redacted, never the environment or the working directory.

**Your service's name** is the only thing you configure, and it defaults to your app's own name (the `name`
in the nearest `package.json`), then `flanj-sdk`. It travels as the OTLP resource `service.name`, and the
collector shows it as a **Service** column beside the counterparty and as a Traffic filter. It names your
own internal topology, so it stays on your collector: a service name is **never sent to the control plane**.

### Instrumenting a client yourself

```js
const { start } = require('@flanj/sdk');
const flanj = start({ serviceName: 'acme-agent' }); // the OTLP pipeline

const client = new Client({ name: 'acme-agent', version: '1.0.0' });
flanj.instrumentMcp(client); // this handle's logger and body cap
await client.connect(transport);
// Use `client` exactly as before. Nothing about its behavior changes.
const result = await client.callTool({ name: 'get_balance', arguments: { account_id: 'acct_1' } });
```

To instrument every client without the zero-code entry, call
`registerMcpAutoInstrumentation({ logger: flanj.logger })` after `start()`.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLANJ_OTLP_ENDPOINT` | `http://localhost:4318/v1/logs` | OTLP/HTTP **logs** endpoint, with the `/v1/logs` path. A bare base URL (`http://localhost:4318`) is normalized to it; any other path is used verbatim. |
| `OTEL_SERVICE_NAME` | the app's own name, else `flanj-sdk` | The `service.name` resource attribute — the only thing you configure to name your service. Order: the `serviceName` option to `start()`, then this variable, then the `name` in the nearest `package.json` walking up from your entry file (or, failing that, your working directory), then `flanj-sdk`. The collector derives each record's **integration** itself — from the peer host on outbound and MCP calls, from this service name on inbound ones — so there is nothing else to set. |
| `FLANJ_BODY_CAP_BYTES` | `16384` | Per-body capture cap, in bytes. |
| `FLANJ_IGNORE_URLS` | — | Comma-separated substrings; a matching URL is never captured. The exporter's own host is always ignored. |
| `FLANJ_TRUSTED_PROXIES` | — | Comma-separated IPs / CIDR blocks of the reverse proxies or load balancers in front of your service (`10.0.0.5,fd00::5`). List the proxies themselves, not your whole network: every address in the set is skipped when walking the chain, so a caller inside it could still pick its own edge class. Inbound calls are classified by their **socket peer**; `X-Forwarded-For` is honoured only from these peers, and the caller is then the hop your proxy appended (the rightmost one that is not itself a trusted proxy), never the leftmost. Unset, the header is ignored, so **behind a proxy every inbound call classifies internal (metadata-only) until you set this**. An entry that is not an IP or CIDR fails `start()`. |
| `FLANJ_FLUSH_TIMEOUT_MS` | `5000` | Upper bound on the exit/`SIGTERM` flush, so a wedged collector can never make your process unkillable. |
| `FLANJ_QUIET` | — | `1` silences the one-line startup notice. |
| `FLANJ_SILENCE_CAPTURE_WARNINGS` | — | Silences the one-time line printed when a capture path fails. Same variable, same line, in the Python SDK. |

`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and `OTEL_EXPORTER_OTLP_ENDPOINT` are honoured as fallbacks, in that
order, if `FLANJ_OTLP_ENDPOINT` is unset, so a host already configured for OTLP needs nothing new.

`start()` takes the same settings as options (`serviceName`, `otlpEndpoint`, `bodyCapBytes`, `ignoreUrls`,
`trustedProxies`), and `instrumentMcpClient` / `handle.instrumentMcp` additionally take `endpoint`,
`serverKind` (`'streamable-http' | 'stdio'` — forces the edge classification instead of detecting it from
the transport; left unset, a transport with a resolvable URL is `streamable-http` and everything else is
`stdio`) and `refetchOnListChanged`.

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

`@opentelemetry/instrumentation-undici`, which gives global `fetch()` its spans, reads undici's diagnostics
channels, while Flanj composes onto undici's global dispatcher. Neither touches the other's hook, so this pair
also works in either registration order, OTel's `traceparent` still reaches the wire, and a real-process test
covers both orders (`test/integration/otel-undici-coexistence.spec.ts`).

Known interaction: calling `disable()` on OTel's http instrumentation while Flanj is loaded removes the
outermost wrapper, which may be Flanj's (that is `shimmer`'s behaviour, shared by every library that
patches this way). Capture comes back with `handle.instrumentation.disable()` followed by `enable()`.

## What is captured

**Captured** — every `tools/call` and `tools/list` on an instrumented MCP client (the fields are listed
under [MCP quick start](#mcp-quick-start)), any HTTP client that goes through Node's core
`node:http` / `node:https` (`axios`, `got`, `node-fetch`, `superagent`, and
`http.request`/`https.request` used directly), and global `fetch()`, which is Node's bundled `undici`
(the OpenAI and Anthropic SDKs, the Vercel AI SDK, the MCP HTTP transport, and server code in Next.js or
Hono that calls out with `fetch`). Both directions for `node:http`: calls your service makes (egress) and
calls it receives (ingress). `fetch()` only makes calls, so it is egress only. Capture is a passive tee on the
bytes already in flight; the call itself is untouched. A `fetch()` that follows a redirect records each hop it
put on the wire.

**Not captured yet** — the calls this SDK has no hook on. Each is silent: zero rows and no warning, while
an `axios` call beside it shows up normally.

- **A `fetch()` given its own `dispatcher`.** The SDK hooks undici's global dispatcher, so a call that
  passes `{ dispatcher }`, or runs after your app installs its own global dispatcher, bypasses it. A global
  dispatcher installed *before* the SDK starts is fine; the SDK stacks on it.
- **A library that replaces `globalThis.fetch`** with an implementation that is not Node's (a polyfill
  installed after the preload, for instance). Only Node's own `fetch` goes through undici's dispatcher.
- **`node:http2`.**
- **`tasks/get` payloads.** A Tasks handle is recorded as an envelope with no body, so nothing models the
  envelope as the tool's output shape.
- **Webhooks you receive** — see Roadmap below.

HTTP bodies are captured only on external edges and only for JSON, text and form content types; JSON includes
every RFC 6839 `+json` media type (`application/problem+json`, `application/vnd.api+json`, `application/hal+json`,
and so on). Internal edges are metadata-only. Every captured body is redacted in your process before it is
stored or exported, and the raw buffer is dropped; see [REDACTION.md](REDACTION.md) for what is redacted and how.

**Edges.** A counterparty is `external` or `internal` by its host, the same rule the collector uses;
internal edges are metadata-only. An MCP server your app launched over stdio is `local-process`, keyed by
the name it reports, and its bodies are captured: it usually wraps someone else's API.

**Inbound calls behind a reverse proxy.** The caller of an inbound call is its socket peer. Behind a load
balancer that is the balancer's private address, so every inbound edge classifies internal and no bodies
are captured. `X-Forwarded-For` is client-controlled, so the SDK does not believe it by default: set
`FLANJ_TRUSTED_PROXIES` to your proxies' addresses (or `trustedProxies` in `start()`) and the header is
honoured from exactly those peers, taking the hop your proxy appended rather than whatever the client sent.

**When capture itself fails** it stops collecting and says so — once, on stderr, naming what broke and that
your application is unaffected. Silence is the failure mode this SDK exists to remove, and a collector
showing nothing looks exactly like an app making no calls. `FLANJ_SILENCE_CAPTURE_WARNINGS=1` turns the
line off once you have read it, and the first failed OTLP **export** prints its own one-time line.

### MCP clients: the contract arrives with the traffic

REST drift detection needs a spec somebody published and kept accurate. MCP servers publish their contract
on every single call — `tools/list` **is** the spec. So the collector has the baseline from the first call
your agent makes, for every MCP server it touches, with nothing to configure and nothing to upload: the
observed `tools/list` is forwarded as a contract snapshot, versioned by content hash, and every later
`tools/call` is checked against it.

That is not a convenience difference. "Nobody publishes an accurate OpenAPI spec" is the strongest practical
objection to drift detection on REST, and it does not apply to MCP at all. It matters most for agents, the most
drift-fragile API consumers anyone has built: an agent reads a tool's description to decide what to do, so a
description that changes under it changes what it does, and nothing anywhere logs an error.

There is nothing to configure per server: the collector derives each MCP server's integration from its peer
host (or, over stdio, the name it reports), so two servers never share a baseline.

### It stays out of the way

The MCP wrapper is out of band like every other capture path here. Three properties are locked by tests
rather than asserted in prose (`src/mcp/instrument-mcp-client.spec.ts`):

- **the call passes through by identity**: the tool's own result object is what your code receives, its
  arguments reach the server verbatim and are never mutated, and a rejection propagates as the *same*
  error object — `listTools` pages too;
- **a broken capture path never reaches the app**: a capture sink that throws is fenced, and the call
  returns normally;
- **the result is read, never consumed**: capture holds no reference past the call.

Both `@modelcontextprotocol` package lines are **optional peers**, feature-detected at runtime. Neither is
imported at build time, and with neither installed the MCP half is a silent no-op.

## Also in this distribution

Also publishes [`@flanj/redaction-patterns`](packages/redaction-patterns/README.md), the standalone
redaction floor — the same detectors this SDK runs, usable on its own.

## Status

Pre-release (v0). See [docs/CONCEPTS.md](docs/CONCEPTS.md) for the engineering model and [CLAUDE.md](CLAUDE.md)
for the repo map.

**Supported:** REST/HTTP integrations — live request and response validated against the provider's OpenAPI document.
**Supported:** MCP tools — tool-definition drift and result-vs-`outputSchema` mismatch, flagged to the server operator with evidence.
**Roadmap:** webhooks (received-webhook contract drift; missing-webhook detection under design).

**Languages.** Node / TypeScript — **supported**: this package, HTTP egress and ingress plus the MCP
client. Python — **early**: [`flanj`](https://github.com/flanj-io/sdk-py), MCP client only, with no HTTP
body capture; there is no `node:http` choke point to port, and for an agent shop with no REST integration
to instrument, MCP-only is a complete product rather than a partial SDK. Apart from HTTP capture the two
are the same SDK: same defaults, same records, same entry points. A language is called *supported* only
once the whole loop runs on it end to end in our own integration harness, with that suite's assertions
green — until then it says early, here and everywhere else.

**Where this stops, said out loud.** A `fetch()` given its own dispatcher, or made by a library that
swapped `globalThis.fetch` for its own implementation, is **not** captured (see *What is
captured*). A REST provider needs a spec somebody published; an MCP server needs none. A call the
collector cannot check against a contract is captured and reported as **not validated**, never as
conforming.

**0.2.0: breaking.** The `integration` option (of `start()`, `instrumentMcpClient` and
`registerMcpAutoInstrumentation`) and `FLANJ_INTEGRATION_ID` are gone, with no shim and no warning: passing
the option is now a type error, and the variable is ignored. The collector now derives every record's integration itself — from the peer host on
outbound and MCP calls, from the resource `service.name` on inbound ones — so the service name is the only
thing you configure. Its default order also changed: the `serviceName` option, then `OTEL_SERVICE_NAME`,
then your app's own name (from the nearest `package.json`), then `flanj-sdk` as a last resort (it was
`flanj-consumer`). An empty value counts as unset.

Flanj turns a detection into something you can act on with the other team. The SDK is open source under
Apache-2.0; the [collector](https://github.com/flanj-io/collector) is source-available under the Elastic
License 2.0; the network layer that carries a flagged finding between the two teams is hosted.

## Development

```bash
yarn install
yarn test     # unit specs plus the real-process integration specs
yarn lint     # eslint
yarn build    # tsc -b, including the workspace redaction package
```

## Security

Report vulnerabilities, including any redaction gap, privately — see [SECURITY.md](SECURITY.md). Never
include a real card number or real personal data.

## License

[Apache-2.0](LICENSE). Contributions require a DCO sign-off; see [CONTRIBUTING.md](CONTRIBUTING.md).

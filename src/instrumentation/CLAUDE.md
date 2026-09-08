# CLAUDE.md — `src/instrumentation/`

The capture core: turn one completed http/https **client or server** call into one fully-redacted
`CapturedCall`, then into the frozen `flanj.*` OTLP log record. This is where the day-one
non-negotiable lives — **redact at source, drop the raw buffer, never attach raw**.

## Files (one export each)

| File | Role |
|---|---|
| `http-body-capture.ts` | `HttpBodyCaptureInstrumentation` — EGRESS: patches core `http`/`https` `request`/`get`, tees request + response bodies, redacts at source, hands a `CapturedCall` to `onCapture`. |
| `http-server-capture.ts` | `HttpServerCaptureInstrumentation` — INGRESS: patches `Server.prototype.emit`, intercepts `'request'`, tees the incoming request body (via the IncomingMessage `push`) + the response body (via `res.write`/`end`), records `res.writeHead`'s headers, emits a `direction="server"` record. |
| `classify-host.ts` | `classifyHost(host)` — the cross-component edge heuristic → `external`\|`internal` (RFC1918 / loopback / link-local / ULA / `.svc.cluster.local`·`.internal`·`.local` / single-label ⇒ internal). Identical byte-for-byte in the collector. |
| `assemble-call.ts` | `assembleCapturedCall` — the shared, direction-agnostic redact-at-source assembler. Bodies are redacted-and-kept ONLY for external edges with a captureable content-type; internal edges keep NO body. Both client and server paths funnel through here. |
| `otlp-record.ts` | `buildLogAttributes` / `emitCall` — map a `CapturedCall` to the `flanj.*` attribute convention (CONTRACTS §2) and emit one log record. Body is empty; all data is in attributes. |
| `captured-call.ts` | `CapturedCall` — the internal, **already-redacted** hand-off type (now carries `peerHost` / `edgeClass` / `captureBodies`). By construction it has no field that can hold a raw body. |
| `decode-body.ts` | `decodeBody` — undo a body's `content-encoding` (gzip · deflate · br, node core `zlib`) before the redactor sees it, output hard-bounded by the cap. A coding it cannot undo returns NO text (`decoded: false`). |
| `capped-buffer.ts` | `CappedBuffer` — accumulates stream chunks up to `body_cap_bytes`, discards the rest, flags `truncated`. The retained bytes are the only copy; there is no separate uncapped buffer. |
| `http-args.ts` | `parseRequestArgs` — normalize the overloaded `request(url, opts, cb)` / `request(opts, cb)` shapes into `{ method, protocol, host, path }`. `host` is the EDGE KEY, so the scheme's own default port is dropped (`:80` on http, `:443` on https) and any other port is kept — see below. |
| `trusted-proxies.ts` | `TrustedProxies` — the configured set of socket peers (IPs / CIDRs, node core `net.BlockList`) whose `X-Forwarded-For` the ingress path may believe. Empty by default ⇒ nobody. An unparseable entry THROWS at construction (i.e. at `start()`). |
| `resolve-ingress-peer.ts` | `resolveIngressPeer` — the ingress CALLER: the socket peer, or — only when that peer is a trusted proxy — the hop the proxy appended to `X-Forwarded-For` (rightmost untrusted hop, walking past trusted tiers; never the leftmost). |
| `config.ts` | `HttpBodyCaptureConfig`, content-type gate, defaults (`DEFAULT_BODY_CAP_BYTES = 16384`), `trustedProxies`. |
| `wrap-layer.ts` | `wrapLayer` / `unwrapLayer` — patch a function by STACKING on whatever is already installed, and remove only our own layer. Carries shimmer's `__original`/`__unwrap` but deliberately NOT `__wrapped`, so `isWrapped()` is false and another instrumentation stacks on us instead of tearing us out. |
| `flanj-instrumentation.ts` | `FlanjInstrumentation` — the base both capture classes extend, in place of OTel's `InstrumentationBase`: config, an enabled flag, `patch()`/`unpatch()`. Installs no module hooks, so it never creates the RITM singleton whose cache silenced OTel's own http instrumentation. |
| `builtin-module.ts` | `builtinModule(id)` — the LIVE, mutable core `http`/`https` exports both capture paths patch, through a `process.getBuiltinModule` reference snapshotted at load so a lookup never seeds another library's require-hook cache. Plus `assertSupportedNodeVersion()` / `SUPPORTED_NODE_RANGE`: that accessor exists only from Node **20.16.0 / 22.3.0**, so below that the SDK is inert and `start()` throws one sentence instead of a `TypeError` from `dist/`. |
| `sync-builtin-esm-exports.ts` | `syncBuiltinEsmExports()` — `module.syncBuiltinESMExports()` behind a never-throw guard: pushes the patched (or restored) `request`/`get` into node:http's ESM facade so ESM named imports / namespaces taken BEFORE `start()` see them. Called at the end of the client path's `patch()` and `unpatch()`. |

## External vs internal (the surfacing floor)

Every captured edge is classified from the **peer** host — egress: the destination; ingress: the
caller — `socket.remoteAddress`, or, **only when that socket peer is a configured trusted proxy**
(`trustedProxies` / `FLANJ_TRUSTED_PROXIES`), the hop the proxy appended to `X-Forwarded-For`
(`resolveIngressPeer`). **External ⇒ bodies captured + redacted; internal ⇒ metadata-only, bodies
are NEVER teed.** The redaction floor cannot be bypassed on
internal edges because there is nothing to bypass — the raw bytes are never read. v0.5 (Step B) adds
the additive edge class `local-process` (stdio MCP servers, `src/mcp/` — bodies captured + redacted);
`classifyHost` itself is unchanged and stays byte-identical to the collector's. Emitted on every
record: `flanj.peer.host`, `flanj.edge.class`, `flanj.capture.bodies`; plus the
OPTIONAL `flanj.peer.addr` (the peer's socket address — egress: the resolved remote
address; ingress: `socket.remoteAddress`) — transport detail for display, never an
identity or edge key, omitted when the socket layer exposed none.

### Why `X-Forwarded-For` is not believed by default (2026-09-07)

The ingress caller used to be the header's FIRST hop whenever the header was present, from any peer.
That hop is client-controlled by definition, so the caller chose its own edge class — and with it
whether its bodies were captured: `X-Forwarded-For: 10.0.0.1` from the public internet ⇒ `internal`
⇒ no bodies ⇒ drift detection blind for that call, silently; a public address claimed from inside ⇒
`external` ⇒ internal bodies captured and stored, exactly what the metadata-only rule exists to
prevent. Now the socket peer is the caller unless it is in `trustedProxies`, and a trusted proxy's
chain is read from the RIGHT: each trusted hop was appended by one of our own tiers, the first
untrusted one is the client (a chain made only of trusted hops originated inside the tier; its
leftmost is reported). Consequence to document wherever the SDK is deployed behind a load balancer:
until the balancer is declared trusted, every inbound call classifies internal. The set is parsed
once, in `setConfig` (the base constructor routes through it), so a typo fails `start()` instead
of silently trusting nobody.

## One origin, one edge key

`info.host` becomes `flanj.peer.host` — `host[:port]`, **the edge key** (CONTRACTS §2) — and the
authority in `flanj.http.url.full`. The collector binds contracts to that key by exact string, so the
same origin dialled two ways MUST produce one string. A URL-string dial goes through WHATWG
`URL.host`, which already omits `:443` on https; an options-object dial carrying an explicit
`{ port: 443 }` did not, so `api.acme.test` and `api.acme.test:443` keyed as two edges: a contract
bound to the first never validated the second, its drifted responses produced no finding, and the
Edges row still showed the contract's name because naming is domain-level while binding is
host-level. Any codebase with a shared `{ hostname, port }` http helper hits this.

So `parseRequestArgs` drops **only** the scheme's own default port. A non-default port stays — `:8080`
is a genuinely different listener, and folding it into the bare host would bind one edge's contract to
another's traffic. The rule is idempotent, and the collector applies the identical one at ingest
(`internal/edge.StripDefaultPort`) so records from older SDKs converge; the two must stay in step.
`src/mcp/resolve-mcp-edge.ts` already keys off `URL.host` and needs nothing.

## The capture path (why it is shaped this way)

1. **Patch the live module, not require-in-the-middle — then re-sync the ESM facade.** Core
   `http`/`https` are usually loaded before the SDK starts, so RITM's hook never re-fires (and
   import-in-the-middle only works behind a loader hook registered before any user module — the
   preload contract anyway, which is why we do not extend OTel's `InstrumentationBase` at all; see
   "Coexisting with another instrumentation" below). `patch()` patches the singleton exports
   `builtinModule('node:http'|'node:https')` returns (Node 20.16+ / 22.3+ — `builtin-module.ts`;
   below that there is nothing patchable, so `start()` refuses)
   — that object is mutable/patchable, whereas an ESM `import * as http` namespace is frozen and
   defeats shimmer. That reaches every property-at-call-time caller but **not** an ESM binding:
   `import { request } from 'node:http'` (and the `import * as` namespace) reads a slot in node:http's
   ESM facade that Node fills from the CJS exports once, when the facade is created. A module that took
   the binding before `start()` kept calling the original — zero rows, silently. So the client path's
   `patch()`/`unpatch()` finish with `module.syncBuiltinESMExports()` (`sync-builtin-esm-exports.ts`),
   which rewrites those slots; ESM imports are live bindings, so already-evaluated importers see the
   patch (and the originals again after `disable()`). The server path needs none of this: it patches
   `Server.prototype.emit`, which every instance looks up at call time, so an `import { createServer }`
   binding was never affected.

   **Supported load patterns** (`test/integration/esm-named-import.spec.ts` locks the ESM named-import
   form, CJS `http.request`, and both preload spellings; `register-flush.spec.ts` the flush; the
   `import * as` namespace and default-import forms are verified by hand, not by a fixture): the preload (`node -r @flanj/sdk/register` / `node --import
   @flanj/sdk/register`, CJS or ESM app); `import`/`require` of `@flanj/sdk/register` or `start()` from
   code, in any position relative to the app's own `node:http` imports; callers via `http.request`,
   `require('http').request`, `import http from`, `import * as http`, `import { request, get }`. Not
   reachable by any patch: calls made before `start()`, and a function copied into a local before then.
   **One caveat:** under an ESM loader hook that REWRITES `node:http` — OTel's import-in-the-middle
   (`--import @opentelemetry/instrumentation/hook.mjs` with `HttpInstrumentation`) — the app's named
   import binds to the hook's wrapper-module copy, which `syncBuiltinESMExports()` cannot reach;
   `start()` from code then misses egress taken before it (1 of 4 records in review). Use the preload
   (`--import @flanj/sdk/register`, after the hook) there.
2. **Tee, don't consume.** Request bodies are teed by wrapping `write`/`end`; response bodies by
   wrapping the `IncomingMessage`'s internal `push`, so a consumer reading with `for await`
   (async iterator) is never starved. **Do not** add a passive flowing-mode `on('data')` listener —
   it silently breaks apps that read the body themselves.
3. **Cap while accumulating.** Each direction feeds a `CappedBuffer(body_cap_bytes)`. Bytes past the
   cap are dropped and `truncated` flips true — a hostile/huge body can never blow memory or the OTLP
   attribute budget.
4. **Undo `content-encoding` before redacting.** Node hands us the RAW wire bytes — `IncomingMessage`
   never decompresses, and compression middleware sits above the `res.write` tee — so a provider
   honouring the default `Accept-Encoding` yields gzip/brotli frames. `decodeBody` inflates them
   (`{ maxOutputLength: body_cap_bytes }`, so a compression bomb cannot expand past the cap, and a
   FLUSH `finishFlush` so a stream cut at the cap still yields its decoded prefix). A coding we cannot
   undo — an unknown one, or a stacked chain — keeps **no body**: storing the frame would put an
   unscanned payload in the record under a text content-type and report it clean. `content-encoding`
   is allowlisted so the row says which happened.
5. **Redact at source, then drop.** On response `end`/null-push we `finalize()` exactly once:
   decode the capped buffer, run it through `@flanj/redaction-patterns` (`redactDetailed`), keep
   **only** the redacted string, and let the raw `CappedBuffer`s go out of scope. No raw body is ever
   set on `CapturedCall`, an attribute, or anything exported — not even transiently. This is asserted
   by the integration test's "no raw body survived anywhere" case.
6. **Content-type gate.** If the direction's content-type is not JSON/text/form, the body is dropped
   entirely (empty string), not redacted-and-kept. Binary/multipart never lands. "JSON" is decided on the
   media type alone (parameters stripped) OR its RFC 6839 base type, so `application/problem+json`,
   `application/vnd.api+json`, `application/hal+json`, … gate exactly as `application/json` (`config.ts`;
   only the `+json` suffix is mapped until the default list grows an XML entry). On the INGRESS path the
   type is derived from the recorded `writeHead` headers merged UNDER `res.getHeaders()`: Node's
   `writeHead(status, headers)` fast path never populates the outgoing-header map when `setHeader` was
   not called first, so `res.getHeader('content-type')` alone reads empty for every Fastify-shaped app
   and silently discards a response body that was already teed.
7. **Header allowlist.** Headers go through `redactHeaders(_, allowlist)` — non-allowlisted keys are
   **dropped** (not redacted); `authorization`/`cookie`/`set-cookie` become a `⟦REDACTED:TOKEN⟧` token
   if ever present in an allowlisted context. Raw credential headers are never emitted.

## Coexisting with another instrumentation (2026-09-08)

The whole pitch is running next to an app's existing OTel setup, and until this fix that silently did not
work. `@opentelemetry/instrumentation-http` patches the same `request`/`get` exports and the same
`Server.prototype.emit`, and **whoever patched second removed the other**, with no error either way:

| registration order | OTel spans | flanj records |
|---|---|---|
| OTel alone | 4 | 0 |
| Flanj alone | 0 | 4 |
| OTel then Flanj | **0** | 4 |
| Flanj then OTel | **0** | 4 |
| ESM preload under OTel's `hook.mjs` | **0** | 4 |

Two independent causes, one per order:

1. **OTel first.** `InstrumentationBase._wrap` is `isWrapped → _unwrap → wrap`: the inherited method
   UNWRAPPED OTel's `outgoingRequest`/`incomingRequest` wrappers before installing ours.
2. **Flanj first.** Constructing an `InstrumentationBase` instantiates `RequireInTheMiddleSingleton`, whose
   hook covers `Module.prototype.require` AND `process.getBuiltinModule` and caches every core module it
   sees. Our own `enable()` lookups filled that cache with `http`/`https` before the app registered
   `HttpInstrumentation`, so OTel's patch never ran.

So: `wrapLayer` instead of `_wrap` (stack, never unwrap), and `FlanjInstrumentation` instead of
`InstrumentationBase` (no module hooks, no singleton). Three rules that must not be "cleaned up":

- **Never mark a layer `__wrapped`.** It is the one shimmer mark we withhold, and the only reason an OTel
  instrumentation registered AFTER us stacks instead of unwrapping us. `isWrapped()` needs all three marks.
- **Never remove a buried layer.** `unwrapLayer` pops only while ours is outermost; the wrapper above holds
  our function by reference and splicing would cut the chain. A buried layer goes inert instead, because
  every patch body checks `isEnabled()` — which is why `disable()` flips the flag BEFORE calling `unpatch()`.
- **Never do work in a subclass field initializer.** The base constructor calls `enable()` → `patch()`, which
  runs before subclass fields are assigned. The layer mark is built inside `patch()`; `trustedProxies` is
  parsed inside `setConfig()`; `trusted` is `declare`d.

One live layer per tag (the instrumentation name): a second `start()` in one process finds ours in the
chain and declines, so the same call is never captured twice. A layer whose owner is disabled does not
count — it is inert, and a fresh instrumentation takes over from it.

That flips which handle wins when an app starts the SDK twice (a preload plus a code-level `start()`, say).
`_wrap` used to unwrap the first instance and install the second, so the LAST start captured; now the FIRST
LIVE one does, and the second handle's sink stays empty. Measured, and the better default: the preload's
handle is the one wired to `flushOnExit`, so a short-lived process no longer loses its last batch.

Known interaction, measured: disabling OTel's http instrumentation at runtime pops the OUTERMOST wrapper,
which may be ours (shimmer's semantics, shared by everyone who patches this way). `disable()` then
`enable()` on our instrumentation reinstalls it.

## Never break

- **Instrumentation must not break the app.** Every patched entry point is wrapped in try/catch; a
  capture failure is swallowed, the original request path is untouched, the consumer still reads the
  full, unmodified response body (integration test: "does not disturb the app").
- **Emit the exact convention.** The attribute key set + scalar values must match
  `contracts/golden-otlp-call.json` (locked by `otlp-record.spec.ts`). Optional attributes
  (`*.content_type`, `corr.*`) are omitted when absent, never emitted empty. Change the wire format in
  the canonical `e2e/contracts` first, then re-vendor.
- **`redaction.patterns` is reported in canonical order** (`PAN, EMAIL, IBAN, SSN, PHONE, CVV, TOKEN,
  IP`) and covers bodies **and** the redacted target/URL, so the emitted set reflects everything that
  fired.
- **`flanj.redaction.fields`** (optional; omitted when empty) carries the whole-value body redactions
  with the ORIGINAL values' captured, non-reversible properties (`{part, path, pattern, props}` — CONTRACTS
  §2). Emitted by `assembleCapturedCall` from `redactDetailed(...).fields`; bodies only, never target/URL.

## Config keys (map to CONTRACTS §8)

`integration` → `flanj.integration`; `bodyCapBytes` → `body_cap_bytes` (default 16384);
`captureContentTypes` → the content-type gate; `headerAllowlist` → the header allowlist;
`ignoreUrls` → URL patterns never captured (`start()` seeds it with its own OTLP export endpoint, so the SDK
never captures its own export — `test/integration/ignore-self-export.spec.ts`); `trustedProxies` →
`FLANJ_TRUSTED_PROXIES`, the ingress-only trusted-proxy set (IPs / CIDRs; default none — SDK-side, not a
collector §8 key); `onCapture` → the sink `start()` wires to the OTLP logger.

## Tests

- `otlp-record.spec.ts` — `CapturedCall → flanj.*` locked to the golden fixture (key set + scalars).
- `../../test/integration/http-capture.spec.ts` — drives a real in-process http call end-to-end and
  asserts: every required `flanj.*` key present, bodies redacted, correlation keys carried, app
  undisturbed, and **no raw PAN reachable** anywhere in the emitted attributes.
- `../../test/integration/http-server-capture.spec.ts` — the INGRESS path end-to-end (`direction="server"`)
  with loopback declared a trusted proxy (`FLANJ_TRUSTED_PROXIES`): the caller is the hop the proxy appended
  (a spoofed private first hop, an internal caller claiming a public one, a two-tier chain, an all-trusted
  chain, a hostname hop), plus the `writeHead` reply idioms (object · `(code, reason, obj)` · flat array)
  A/B'd against `setHeader`, and a gzip'd response (the compression-middleware shape).
- `../../test/integration/http-server-capture-untrusted.spec.ts` — the DEFAULT (no trusted proxies): the
  header is ignored from any peer, public or private claims alike; and an unparseable entry fails `start()`.
- `trusted-proxies.spec.ts` / `resolve-ingress-peer.spec.ts` — the set (IPs, CIDRs, mapped/zoned/ported
  spellings, non-IP hops never trusted, invalid entries throw) and the right-to-left walk.
- `../../test/integration/http-capture-encoding.spec.ts` — EGRESS gzip/brotli responses are stored decoded and
  tokenised, with an identity control on the same server and an unknown-coding honest-empty case.
- `decode-body.spec.ts` — the codings, the cut-at-the-cap prefix, the over-cap bound, and the honest-empty paths.
- `../../test/integration/ignore-self-export.spec.ts` — the SDK's own OTLP export is never captured.
- `../../test/integration/esm-named-import.spec.ts` — REAL ESM children under the built `dist/register.js`: a
  module that took `import { request, get, createServer } from 'node:http'` BEFORE the SDK started has every
  call captured (the facade re-sync), and the `node --import <register>` preload form works.
- `wrap-layer.spec.ts` / `flanj-instrumentation.spec.ts` — the stacking patch (stacks, is not `isWrapped`,
  pops only when outermost, one live layer per tag) and the lifecycle it rests on.
- `../../test/integration/otel-coexistence.spec.ts` — REAL children registering
  `@opentelemetry/instrumentation-http` against an InMemorySpanExporter AND `start()`, in BOTH orders plus
  the ESM preload under OTel's `hook.mjs`: OTel still records its client and server spans while Flanj still
  emits one record per call. Fails 4/7 on the pre-fix code.
- `classify-host.spec.ts` — the external/internal edge heuristic.

# CLAUDE.md — `src/instrumentation/`

The capture core: turn one completed http/https **client or server** call into one fully-redacted
`CapturedCall`, then into the frozen `flanj.*` OTLP log record. This is where the day-one
non-negotiable lives — **redact at source, drop the raw buffer, never attach raw**.

## Files (one export each)

| File | Role |
|---|---|
| `http-body-capture.ts` | `HttpBodyCaptureInstrumentation` — EGRESS: patches core `http`/`https` `request`/`get`, tees request + response bodies, redacts at source, hands a `CapturedCall` to `onCapture`. |
| `http-server-capture.ts` | `HttpServerCaptureInstrumentation` — INGRESS: patches `Server.prototype.emit`, intercepts `'request'`, tees the incoming request body (via the IncomingMessage `push`) + the response body (via `res.write`/`end`), emits a `direction="server"` record. |
| `classify-host.ts` | `classifyHost(host)` — the cross-component edge heuristic → `external`\|`internal` (RFC1918 / loopback / link-local / ULA / `.svc.cluster.local`·`.internal`·`.local` / single-label ⇒ internal). Identical byte-for-byte in the collector. |
| `assemble-call.ts` | `assembleCapturedCall` — the shared, direction-agnostic redact-at-source assembler. Bodies are redacted-and-kept ONLY for external edges with a captureable content-type; internal edges keep NO body. Both client and server paths funnel through here. |
| `otlp-record.ts` | `buildLogAttributes` / `emitCall` — map a `CapturedCall` to the `flanj.*` attribute convention (CONTRACTS §2) and emit one log record. Body is empty; all data is in attributes. |
| `captured-call.ts` | `CapturedCall` — the internal, **already-redacted** hand-off type (now carries `peerHost` / `edgeClass` / `captureBodies`). By construction it has no field that can hold a raw body. |
| `capped-buffer.ts` | `CappedBuffer` — accumulates stream chunks up to `body_cap_bytes`, discards the rest, flags `truncated`. The retained bytes are the only copy; there is no separate uncapped buffer. |
| `http-args.ts` | `parseRequestArgs` — normalize the overloaded `request(url, opts, cb)` / `request(opts, cb)` shapes into `{ method, protocol, host, path }`. `host` is the EDGE KEY, so the scheme's own default port is dropped (`:80` on http, `:443` on https) and any other port is kept — see below. |
| `config.ts` | `HttpBodyCaptureConfig`, content-type gate, defaults (`DEFAULT_BODY_CAP_BYTES = 16384`). |

## External vs internal (the surfacing floor)

Every captured edge is classified from the **peer** host — egress: the destination; ingress: the
caller (`X-Forwarded-For` first hop, else `socket.remoteAddress`). **External ⇒ bodies captured +
redacted; internal ⇒ metadata-only, bodies are NEVER teed.** The redaction floor cannot be bypassed on
internal edges because there is nothing to bypass — the raw bytes are never read. v0.5 (Step B) adds
the additive edge class `local-process` (stdio MCP servers, `src/mcp/` — bodies captured + redacted);
`classifyHost` itself is unchanged and stays byte-identical to the collector's. Emitted on every
record: `flanj.peer.host`, `flanj.edge.class`, `flanj.capture.bodies`; plus the
OPTIONAL `flanj.peer.addr` (the peer's socket address — egress: the resolved remote
address; ingress: `socket.remoteAddress`) — transport detail for display, never an
identity or edge key, omitted when the socket layer exposed none.

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

1. **Patch the live module, not require-in-the-middle.** Core `http`/`https` are usually loaded
   before the SDK starts, so RITM's hook never re-fires. `enable()` patches the singleton exports
   returned by `process.getBuiltinModule('node:http'|'node:https')` (Node 22.3+) — that object is
   mutable/patchable, whereas an ESM `import * as http` namespace is frozen and defeats shimmer.
2. **Tee, don't consume.** Request bodies are teed by wrapping `write`/`end`; response bodies by
   wrapping the `IncomingMessage`'s internal `push`, so a consumer reading with `for await`
   (async iterator) is never starved. **Do not** add a passive flowing-mode `on('data')` listener —
   it silently breaks apps that read the body themselves.
3. **Cap while accumulating.** Each direction feeds a `CappedBuffer(body_cap_bytes)`. Bytes past the
   cap are dropped and `truncated` flips true — a hostile/huge body can never blow memory or the OTLP
   attribute budget.
4. **Redact at source, then drop.** On response `end`/null-push we `finalize()` exactly once:
   decode the capped buffer, run it through `@flanj/redaction-patterns` (`redactDetailed`), keep
   **only** the redacted string, and let the raw `CappedBuffer`s go out of scope. No raw body is ever
   set on `CapturedCall`, an attribute, or anything exported — not even transiently. This is asserted
   by the integration test's "no raw body survived anywhere" case.
5. **Content-type gate.** If the direction's content-type is not JSON/text/form, the body is dropped
   entirely (empty string), not redacted-and-kept. Binary/multipart never lands.
6. **Header allowlist.** Headers go through `redactHeaders(_, allowlist)` — non-allowlisted keys are
   **dropped** (not redacted); `authorization`/`cookie`/`set-cookie` become a `⟦REDACTED:TOKEN⟧` token
   if ever present in an allowlisted context. Raw credential headers are never emitted.

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
never captures its own export — `test/integration/ignore-self-export.spec.ts`); `onCapture` → the sink
`start()` wires to the OTLP logger.

## Tests

- `otlp-record.spec.ts` — `CapturedCall → flanj.*` locked to the golden fixture (key set + scalars).
- `../../test/integration/http-capture.spec.ts` — drives a real in-process http call end-to-end and
  asserts: every required `flanj.*` key present, bodies redacted, correlation keys carried, app
  undisturbed, and **no raw PAN reachable** anywhere in the emitted attributes.
- `../../test/integration/http-server-capture.spec.ts` — the INGRESS path end-to-end (`direction="server"`).
- `../../test/integration/ignore-self-export.spec.ts` — the SDK's own OTLP export is never captured.
- `classify-host.spec.ts` — the external/internal edge heuristic.

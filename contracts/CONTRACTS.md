# Flanj — Cross-repo Contracts (v1)

**This directory is the single source of truth for every cross-component contract in Flanj.**
The SDKs, the collector and the hosted control plane all key off the fixtures and schemas here.
Nothing on the coupling surface changes except by editing this directory and re-broadcasting a new
`schema_version`. See [README.md](./README.md) for governance, versioning, and vendoring rules.

`schema_version` for everything below is **1**. Payloads carry it explicitly so the CP can stay
backward-compatible with older self-hosted collectors (see §7).

---

## 1. Version pins (freeze — identical across all repos)

| Area | Module / package | Pin |
|---|---|---|
| OTel JS API | `@opentelemetry/api` | `^1.9.0` |
| OTel JS SDK + instrumentation | `@opentelemetry/sdk-node`, `instrumentation-http`, `api-logs`, `sdk-logs`, `exporter-logs-otlp-http` | `^0.221.0` |
| Collector builder (ocb) | `go.opentelemetry.io/collector/cmd/builder` | `v0.159.0` |
| Collector beta components | e.g. `…/receiver/otlpreceiver` (**core, not contrib**), `…/config/confighttp` | `v0.159.0` |
| Collector stable components | `…/collector/extension`, `…/component`, `…/pdata` | `v1.65.0` |
| Go SQLite (pure-Go, CGO off) | `modernc.org/sqlite` | `v1.56.0` |
| Go Postgres driver (pure-Go, CGO off; `backend=postgres` store) | `github.com/jackc/pgx/v5` (via `pgx/v5/stdlib`) | `v5.10.0` |
| OpenAPI validate (live-vs-spec) | `github.com/getkin/kin-openapi` | `v0.146.0` |
| OpenAPI breaking-diff (version-diff) | `github.com/oasdiff/oasdiff` (the maintained module; `tufin/oasdiff` redirects here) | `v1.29.1` |
| Mail (dev) | `axllent/mailpit` (HTTP API v1) | current |

> **ocb version triad is the #1 build hazard:** ocb `v0.159.0` **must** pair with beta components
> `v0.159.0` and stable components `v1.65.0`. Any skew fails the build.

---

## 2. OTLP wire convention (SDK → collector)

Transport: **OTLP/HTTP protobuf on `:4318`** (path `/v1/logs`). One **OTLP Log record per completed
HTTP call** — and, since v0.5 (Step B), one per completed **MCP tool call** plus one `contract_snapshot`
record per observed `tools/list` (the MCP blocks below). The SDK redacts at source **before** the record
is constructed; raw bodies never reach OTLP.

**Resource attributes** *(2026-09-19)* — set once per OTLP `Resource` and shared by every record under
it; not `flanj.*` keys. `service.name` is the emitting service: on an outbound (`client`) call record
the CALLER, on an inbound (`server`) one the service the call reached. Both SDKs set it from their
service-name option, else `OTEL_SERVICE_NAME`, else the app's own name, else `"flanj-sdk"`
*(2026-09-19; it was `"flanj-consumer"`)*. The app's own name, resolved once when `start()` runs and
never at import:
- **TypeScript:** the non-empty string `name` of the nearest `package.json` that has one, walking up
  from the directory of the entry file (`process.argv[1]`, symlinks resolved as Node resolves the main
  module), and when that finds none, walking up from the working directory. With no entry file (a
  REPL, `node -e`, `node -p`) or no such `package.json` → `"flanj-sdk"`.
- **Python:** under `python -m pkg.mod`, `__main__.__spec__.name` with a trailing `.__main__` removed
  (`python -m myapp` → `myapp`); else the basename of `__main__.__file__` without `.py`
  (`python path/app.py` → `app`; a launcher such as gunicorn or uvicorn yields the launcher's own script
  name, as Datadog's does). A result of `__main__` (a directory or zip run as a script) is no name. A
  REPL, `python -c`, or an embedded interpreter with neither → `"flanj-sdk"`. No file is read.
The collector reads it off each call record's resource into the stored call's `service_name` (§3), for
local display and filtering, and on an inbound call it is also the call's integration (the
`flanj.integration` row below). Every other resource attribute is ignored.

Log record `body` is empty; all data is in **attributes**. Attribute keys (carrier-agnostic — identical
if ever moved to a span event):

| Attribute | Type | Notes |
|---|---|---|
| `flanj.capture.version` | string | `"1"` — the redaction/capture manifest version |
| `flanj.record.type` | string | `"call"` — one completed call. Since v0.5 (Step B) the SDK also emits `"contract_snapshot"` (an observed MCP `tools/list` — see the MCP block below); older collectors drop the unknown type silently, so the addition is forward-compatible with no `schema_version` bump. The collector reuses the same pipeline for its own internal record types `"finding"` and `"spec_info"` (below), which also cross the front→store hop of the tiered topology. |
| `flanj.direction` | string | `"client"` = egress (org is **consumer**) \| `"server"` = ingress (org is **provider**) |
| `flanj.peer.host` | string | the OTHER end's host[:port] — egress: the destination; ingress: the caller/source. The edge key. |
| `flanj.peer.addr` *(optional)* | string | the peer's socket address (IP) when the socket layer exposed one — egress: the resolved remote address; ingress: `socket.remoteAddress` (behind a proxy: the last hop's). Transport detail for display/debugging; NEVER an identity or edge key. Omitted when unknown. |
| `flanj.edge.class` | string | `"external"` \| `"internal"` — classification of `peer.host`, byte-identical in SDK + collector. **Internal** = RFC1918 (10/8, 172.16-31/12, 192.168/16) / loopback (127/8, `::1`) / unspecified (`::`) / link-local (169.254/16, `fe80::/10`) / ULA (`fc00::/7`) / a name ending `.svc.cluster.local`·`.internal`·`.local` / single-label host. `::ffff:` IPv4-mapped addresses are unmapped first. Else **external**. v0.5 (Step B) adds the additive value `"local-process"`: a stdio MCP server (see the MCP block below) — bodies ARE captured + redacted (a local MCP process usually fronts an external API; the contract is the server's), unlike `internal` which stays metadata-only. The Python SDK adds `"unknown"`: an MCP server whose transport the SDK never saw, so it cannot tell remote from local — **metadata-only** (it might be internal), `peer.host` = `serverInfo.name`, and the SDK says so once on stderr. Never emitted by the TypeScript SDK (see *SDK parity* below). Consumers treat any class other than `external` as not an integration-graph edge, so it is carried as a plain string. One consequence for the collector: like `local-process`, an `unknown` row's `peer.host` is a self-reported name, not a host, so it never seeds another pod's MCP baseline. |
| `flanj.capture.bodies` | bool | `true` on external edges (bodies present) · `false` on internal (bodies OMITTED — internal is metadata-only, classified out of surfacing). |
| `flanj.integration` *(deprecated 2026-09-19)* | string | **Ignored by the collector, and sent by neither SDK since @flanj/sdk 0.2.0 (the Python SDK never sent it in a release).** The collector derives every record's integration at ingest, the same way at every pod: an **outbound** HTTP call and any **MCP** record (call or `contract_snapshot`) → `integrationForHost(flanj.peer.host)` (ASCII letters lowercased, digits kept, every other character `-`, runs of `-` collapsed, ends trimmed), `"unknown-integration"` when that yields nothing; an **inbound** HTTP call → the record's resource `service.name` (the service the call reached; `"unknown-integration"` when the resource carries none). An older SDK that still sends the attribute lands on the same key as a new one. The key is internal: it never replaces the service (`service_name`, §3) or the counterparty (`flanj.peer.host`), and because the §4 finding signature starts with it, a finding opened under an SDK-sent id is not carried over: its next occurrence opens a new finding under the derived key, once. |
| `flanj.http.method` | string | `"POST"` |
| `flanj.http.route` | string | templated if known (`"/v1/charges"`) else path |
| `flanj.http.target` | string | redacted path+query |
| `flanj.http.url.full` | string | redacted absolute URL |
| `flanj.http.status_code` | int | `200` |
| `flanj.http.request.content_type` | string | |
| `flanj.http.request.body` | string | **redacted**, capped at `body_cap_bytes` |
| `flanj.http.request.body.truncated` | bool | |
| `flanj.http.request.headers` | string | **redacted** JSON, allowlisted keys only |
| `flanj.http.response.content_type` | string | |
| `flanj.http.response.body` | string | **redacted**, capped |
| `flanj.http.response.body.truncated` | bool | |
| `flanj.http.response.headers` | string | **redacted** JSON, allowlisted |
| `flanj.corr.request_id` | string | from `x-request-id`/`x-correlation-id` |
| `flanj.corr.idempotency_key` | string | from `idempotency-key` |
| `flanj.corr.trace_id` | string | hex |
| `flanj.corr.span_id` | string | hex |
| `flanj.http.duration_ms` | int | |
| `flanj.redaction.applied` | bool | |
| `flanj.redaction.patterns` | string | JSON array of fired pattern ids, e.g. `["PAN"]` |
| `flanj.redaction.spec_aware` | bool | v0 = `false` |
| `flanj.redaction.fields` *(optional)* | string | JSON array of whole-value body redactions with the ORIGINAL value's captured properties; omitted when empty. Entries `{part: "request"\|"response", path, pattern, props}` — `path` an RFC 6901 JSON Pointer into that body; `props` = `{type: "string"\|"number", length (Unicode code points of the original scalar text), integer? (numbers), containsLowerCase (a-z), containsUpperCase (A-Z), containsDigits (0-9), containsASCIIControlChars (≤0x1F or 0x7F), containsASCIIPrintableChars (0x20–0x7E), containsASCIIExtendedChars (>0x7F)}`. Sorted by part (request first) then path. Non-reversible by design (never anything that narrows the value). Emitted only for whole-value redactions (the scalar became exactly one token); span-in-text redactions, redacted keys, form pairs and non-JSON text carry no fields. Purpose: the collector's drift detector validates the DECIDABLE constraints (type, min/maxLength) of redacted fields instead of skipping them (§6 Drift interplay). |

**MCP tool-call records — v0.5 (Step B)** (additive; emitted by the SDK's MCP client wrapper,
`instrumentMcpClient`, one record per completed `tools/call`): the SAME `"call"` record shape as HTTP,
with the tool riding the method/route slots — `flanj.http.method` = `"tools/call"`,
`flanj.http.route` = `flanj.http.target` = `"/<tool.name>"`, `flanj.http.url.full` =
`"mcp://<peer.host>/<tool.name>"` (synthetic, display only). The request body is the `tools/call`
**arguments** (JSON); the response body is **`structuredContent`** when present (content-type
`application/json`), else the `content[]` text items joined with newlines (`text/plain` — the floor's
text path parses-then-traverses JSON text, so a PAN inside stringified JSON is caught structurally,
not by a regex). Headers are `"{}"`; `flanj.http.status_code` is **omitted** (MCP has none —
`flanj.mcp.is_error` carries the outcome); every body is floor-redacted at source with
`redaction.fields` captured exactly as on HTTP. `flanj.peer.host` = the streamable-HTTP endpoint
host[:port], or `serverInfo.name` for a stdio server (edge class `"local-process"`); a streamable-HTTP
peer classified `internal` stays metadata-only as ever. Additive attributes:

> **SDK parity.** The TypeScript and Python SDKs share every default and emit the same records. The one
> intended difference is that the Python SDK does no HTTP body capture. Everything else is the same surface:
> both zero-code entries (`node -r @flanj/sdk/register`, `import flanj.register`) start the OTLP pipeline,
> flush on exit and **auto-instrument every MCP client**, and both handles expose an explicit per-client
> equivalent (`handle.instrumentMcp(client)`, `handle.instrument(session)`) and the same one-time
> capture-failure line under `FLANJ_SILENCE_CAPTURE_WARNINGS`. The TypeScript entry additionally switches on
> HTTP body capture, which is the intended difference above.
>
> One further difference follows from the runtime and is recorded here so it is not re-litigated as a bug:
>
> - **Edge class `"unknown"` (Python only).** A JavaScript MCP `Client` keeps its transport, and the
>   transport knows its URL, so the TypeScript SDK can always place a server. A Python `ClientSession` holds
>   two in-memory streams and no URL: the SDK learns where a server is when its transport *opens* (it wraps
>   `streamable_http_client` / `sse_client` / `stdio_client`). A session whose transport was opened before the
>   SDK loaded is `"unknown"` — metadata-only, never guessed. Hence the Python SDK's load-first rule.

> **Server identity, since protocol revision 2026-07-28.** That revision removed the `initialize` /
> `notifications/initialized` handshake and protocol-level sessions, so the client accessors the v0.5
> wrapper read identity from (`getServerVersion()`, `serverInfo`, `protocolVersion`) are empty against a
> current server. Identity now arrives in the **`_meta` of every result**
> (`io.modelcontextprotocol/serverInfo`) and is read from there first, with the handshake accessors kept
> only as a fallback for older servers. This is load-bearing, not cosmetic: `flanj.peer.host` for a stdio
> server IS `serverInfo.name`, so without a source for it every local server on a host collapses onto one
> edge key and their alternating tool lists become phantom `definition_change` findings.

| Attribute | Type | Notes |
|---|---|---|
| `flanj.transport` | string | `"mcp"`. Absent on HTTP records (absent = HTTP). |
| `flanj.mcp.tool.name` | string | the called tool — the operation id downstream detection matches against the contract (`Operation.id` / `Match.toolName`). |
| `flanj.mcp.is_error` | bool | the CallToolResult's `isError` (also `true` when the call itself rejected). Feeds the error-rate metric; never a finding on its own. |
| `flanj.mcp.error.code` *(optional, additive 2026-09-17)* | int | the JSON-RPC `error.code` when the `tools/call` **request itself** was rejected — set only then, never for a result with `isError`. `-32602` (invalid params) on arguments whose shape previously succeeded is the `input_rejection` finding (§4). Absent on SDKs older than the field; readers must tolerate its absence. **Emitted by both SDKs, read only off a protocol error** (`McpError` / `ProtocolError` and its subclasses — a transport error's HTTP status on the same `.code` is never a JSON-RPC code). |
| `flanj.mcp.via_dispatch` *(optional, additive 2026-09-18; set by the collector, never an SDK)* | string | the discovery **dispatcher** a `tools/call` went through, stamped by the drift processor when it re-attributed the call to the inner tool it named (§4, *Servers behind discovery meta-tools*): `flanj.mcp.tool.name` and `flanj.http.route` then name that inner tool, and the request body stays the literal dispatcher call. Stored on the call as `via_dispatch`; absent on every call that was not re-attributed. |
| `flanj.mcp.server.name` *(optional)* | string | `serverInfo.name`. Read from the `_meta` of the result (`io.modelcontextprotocol/serverInfo`, revision 2026-07-28), falling back to the client's `initialize`-derived accessors on an older server. |
| `flanj.mcp.server.version` *(optional)* | string | `serverInfo.version`, same source and precedence. |
| `flanj.mcp.protocol.version` *(optional)* | string | the MCP protocol version, when surfaced. |
| `flanj.mcp.session.id` *(optional)* | string | `Mcp-Session-Id` when the transport exposes one (2025-11-25 line; absent on 2026-07-28 stateless). |
| `flanj.mcp.result.type` *(optional)* | string | the result's `resultType` (revision 2026-07-28) verbatim: `"complete"`, `"input_required"`, or a later revision's value. **Absent means an older server said nothing — never `"complete"`.** `input_required` is normal traffic on an interactive tool: the payload is partial by design, so detection skips the record rather than judging it. |
| `flanj.mcp.task.id` *(optional)* | string | set when the result was a Tasks **handle** rather than a payload (revision 2026-07-28 moved long-running work to the Tasks extension: the call returns `{task:{taskId,…}}` and the payload arrives via `tasks/get`). The record then carries the ENVELOPE — the response body is empty — and nothing may validate or model response shape from it. |
| `flanj.corr.trace_id` / `flanj.corr.span_id` *(optional)* | string | W3C trace context lifted from the result's `_meta.traceparent` (revision 2026-07-28). Omitted when the header is absent or malformed — a wrong correlation key points a provider at somebody else's request, so a bad `traceparent` yields nothing rather than a bogus id. |
| `flanj.corr.client_request_id` *(optional)* | string | the JSON-RPC id observed on the client's OWN outgoing message — **client-generated**: it appears in the provider's logs only if they log it. Rendered as "JSON-RPC id (client-generated)", and never merged into `flanj.corr.request_id`, which stays **provider-issued only** (the v0.5 client wrapper sees no HTTP response headers and therefore emits none). |

Canonical example: [`v1/golden-otlp-mcp-call.json`](./v1/golden-otlp-mcp-call.json) — one
`create_refund` call whose `structuredContent` returns `refund.amount` as the string `"1200"` where the
tool's `outputSchema` declares integer (Step C's `output_mismatch` evidence), card number redacted at
source with captured props.

**`contract_snapshot` records — v0.5 (Step B)** (additive; emitted by the SDK's MCP client wrapper):
one record per **complete** observed `tools/list` (pagination followed; re-fetched and re-emitted after
`notifications/tools/list_changed`). This is the self-delivering local spec — Step C loads it as
`Contract{source:"mcp"}`, versioned by content hash, provenance "observed tools/list at <ts>" where
<ts> is the log record's own timestamp. Attribute set:

| Attribute | Type | Notes |
|---|---|---|
| `flanj.capture.version` | string | `"1"` |
| `flanj.record.type` | string | `"contract_snapshot"` |
| `flanj.transport` | string | `"mcp"` |
| `flanj.direction` | string | `"client"` |
| `flanj.peer.host` / `flanj.edge.class` | | as on MCP call records (same edge key). `flanj.integration` is deprecated and ignored here too: the collector derives the snapshot's integration by the call rule, so a server's catalogue and its calls always share one key. |
| `flanj.mcp.contract_snapshot` | string | **floor-redacted** JSON `{"tools":[…], "serverInfo"?, "protocolVersion"?, "capabilities"?, "ttlMs"?, "cacheScope"?}`. Each tool carries exactly the ToolDef wire keys `name` / `description` / `inputSchema` / `outputSchema` / `annotations` (decodable by the collector's `contract.ParseToolsList`); schemas are the server's own words, passed verbatim — a tool without `outputSchema` keeps none (the honest "no output contract declared" state, never synthesized). `capabilities` carries `{tools:{listChanged}}` when the client surfaces it. |
| `flanj.mcp.tool.count` | int | tools in the snapshot. |
| `flanj.mcp.server.name` / `flanj.mcp.server.version` / `flanj.mcp.protocol.version` *(optional)* | string | server identity, same source and precedence as on call records. |
| `flanj.mcp.catalog.ttl_ms` *(optional)* | int | the `ttlMs` the `tools/list` result published (revision 2026-07-28). Clients are now told to **cache** catalogs, so the list a snapshot records may legitimately be up to this far behind the server — a surface that presents a snapshot as live would be overstating it. Also carried inside the document, so the stored snapshot stays self-describing. |
| `flanj.mcp.catalog.cache_scope` *(optional)* | string | the result's `cacheScope`, same source. |
| `flanj.mcp.server.command` *(optional, additive 2026-09-18)* | string | **stdio servers only** (`flanj.edge.class` = `local-process`): how the client launched the server, so a reader can see *which package* is behind a self-reported `serverInfo.name` (a vendor's `npx @stripe/mcp` and a third party's `npx someone/stripe-mcp` otherwise look alike). A compact JSON array `[command, ...args]` (no whitespace between tokens, non-ASCII written raw — `JSON.stringify` / `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`). Each element is **floor-redacted on its own** with the text entry point (`redact(element)`) before the array is built. **Capped at 1024 UTF-8 bytes** of the serialized array: elements are kept in order while the array, plus a closing `"…"` element, still fits; when any element had to be dropped the last element is exactly `"…"` (U+2026). The command itself is always kept; if even `[command, "…"]` does not fit, the attribute is omitted. **Never** the environment or the working directory — those carry credentials. Absent for URL-addressed servers, and when the transport's parameters are not observable. Recorded for **local display** on the collector's contract card; it is not part of any flag payload. |
| `flanj.redaction.applied` / `flanj.redaction.patterns` | bool / string | the floor pass over the snapshot JSON (usually nothing fires; the floor still runs — every captured payload is floor-scanned first, §6). |

Canonical example: [`v1/golden-otlp-mcp-snapshot.json`](./v1/golden-otlp-mcp-snapshot.json).

**Collector-internal record types** (never emitted by the SDK; produced by the collector's drift
processor and consumed by its store exporter — in the tiered topology they travel from a front
collector to the store pod over the core `otlphttp` exporter as ordinary OTLP log records):

| `flanj.record.type` | Carries | Notes |
|---|---|---|
| `"finding"` | `flanj.finding.json` = the whole §4 Finding as JSON | Appended after the calls of the batch that produced it. Order is NOT load-bearing: the store pins a finding's source call whichever arrives first (late pin). |
| `"spec_info"` | `flanj.spec_info.json` = the loaded contract's metadata `{integration, role ("provider"\|"self"), peer_host?, format, title?, version?, docs_url?, endpoints?, loaded_at}`; the raw spec document in the log record **body as bytes** (may be empty) | Emitted by a collector that loaded a spec: on the first batch after start, then at most every 10 minutes, so a store pod (or a freshly wiped store) converges. Idempotent upsert keyed by `integration`. |

A store that does not recognise a record type drops it silently (it never becomes a call: the
store exporter requires method + route). Unknown types are therefore forward-compatible; upgrade
the store pod before the fronts.

**Collector-internal attributes on `"call"` records — the per-call verdict** *(2026-09-07; additive,
`schema_version` stays 1; never emitted by the SDK)*. The drift processor stamps EVERY call record that
passes through it — on every branch of its per-call path, the ones that validate nothing included — with
what it did. In the tiered topology the stamp crosses the front→store hop with the record.

| Attribute | Type | Notes |
|---|---|---|
| `flanj.validated` | string | `"clean"` — validated against its contract, nothing found · `"drifted"` — validated, and the call departed from the contract (a `live-vs-spec` / `output_mismatch` finding names it) · `"not-validated"` — the processor saw the call and explicitly could not validate it. **Absent** on a record no drift processor saw (an older front; a pipeline without `flanjdrift`); the store decodes absence as `"unknown"` — never as clean. |
| `flanj.validated.reason` *(optional)* | string | Present iff `flanj.validated` is `"not-validated"`: the FIRST gate that stopped validation, in the processor's own order. `no-contract` (nothing bound to the call's edge in the processor's cache at that moment — nothing uploaded, an upload it has not loaded yet, a tiered front that cannot read the store pod, no self contract configured; MCP: no `tools/list` snapshot observed yet) · `not-routable` (a bound document does not describe the call — method + path, or the request could not be reconstructed) · `status-undeclared` (the document routes the call but declares no response for this status — nothing to compare the body to; not a finding kind yet, and never clean) · `media-type-undeclared` (the status is declared via a `4XX`/`5XX` **range** or **only via `default`**, and not with this media type — a `502 text/html` gateway page under a contract whose `default` response declares `application/json`; same posture, and permanent: a `default` response is a catch-all, so an unexpected media type on it is not evidence that the provider breached anything. A status declared by **exact code** with an undeclared media type is NOT this reason: flanj-io/collector#44 makes it a `live-vs-spec` finding, rule `content-type-mismatch` — the provider's own published response shape departed — and the call is stamped `drifted`. #44 also validates an RFC 6839 `+json` body against the declared `application/json` schema, `default` included, before any of these gates) · `body-not-decodable` (the body could not be read or decoded as its declared media type) · `response-header-missing` (the document requires a response header the captured call does not carry — headers reach the collector through the SDK allowlist — so the validator stopped before the body) · `no-schema` (the validator had nothing to compare: a HEAD or redirect status it skips, an operation with no responses, a declared response with no body content, or a media type declared without a schema — never clean) · `validator-error` (refused for a reason the collector does not classify) · MCP, in `DetectCall` order: `tool-not-listed` · `input-required` · `no-output-contract` · `error-result` · `task-handle` · `result-not-json`. Readers tolerate values they do not know. |

*Why a stamp.* Until 2026-09-07 the collector UI DERIVED "was this call checked?" from the store's
contract list — a document bound to the call's host, bound before the call was captured. Both are
facts about the store, and the drift processor learns of an upload later than the store does: its
spec cache refreshes on an announced kick floored at 5 s, a tiered front on a 10 s ticker, a front
with the wrong `store_pod_token` never. A drifting charge driven inside that window went through the
processor unvalidated, produced no finding and no drifted flag, and rendered CONFORMING — beside the
healthy front's DRIFTED for the same charge on the tiered shape, and permanently on the mis-tokened
front. Only the process that validates can say whether it did. Readers treat a missing or
`not-validated` stamp as **not checked** — never conforming.

Canonical example: [`v1/golden-otlp-call.json`](./v1/golden-otlp-call.json) — one drifting charge call
(response `amount` returned as the string `"1200"` where the spec declares integer), card number already
redacted. The collector's contract test ingests this and must deterministically emit the expected Finding.

**Header allowlist** (everything else dropped, not redacted): `content-type`, `content-length`,
`content-encoding`, `x-request-id`, `x-correlation-id`, `idempotency-key`, `user-agent`, `date`.
`authorization`, `cookie`, `set-cookie` are **redacted to a `⟦REDACTED:TOKEN⟧` token if present in an
allowlisted context**, never emitted raw.

**Content-encoded bodies are stored DECODED.** A capturing SDK sits below the client library that
inflates (`IncomingMessage` never decompresses), so it must undo any `content-encoding` — `gzip`/`x-gzip`,
`deflate`/`x-deflate`, `br` — BEFORE redaction, and `body_cap_bytes` then applies to the decoded bytes.
A coding it cannot undo (anything else, or a stacked chain) stores **no body**: raw compressed bytes must
never be stored under a text content-type, and never counted as scanned (`redaction.applied` would be a
falsehood). `content-encoding` is allowlisted so the row distinguishes the two cases.

---

## 3. `RedactedCall` (collector store ↔ CP)

JSON Schema: [`v1/redacted-call.schema.json`](./v1/redacted-call.schema.json). Sample:
[`v1/sample-redacted-call.json`](./v1/sample-redacted-call.json).

```jsonc
{
  "schema_version": 1,
  "id": "0191e8c4-…",                       // uuidv7
  "captured_at": "2026-08-18T08:00:00.000Z", // RFC3339
  "integration": "acme-payments",
  "direction": "client",
  "method": "POST",
  "url": "https://api.acme.test/v1/charges", // redacted
  "route": "/v1/charges",
  "status_code": 200,
  "request_headers":  { "content-type": "application/json", "idempotency-key": "idem_abc" },
  "request_body": "{\"amount\":1200,\"currency\":\"usd\",\"source\":\"⟦REDACTED:PAN⟧\"}",
  "request_body_truncated": false,
  "request_content_type": "application/json",
  "response_headers": { "content-type": "application/json", "x-request-id": "req_xyz" },
  "response_body": "{\"id\":\"ch_1\",\"amount\":\"1200\",\"currency\":\"usd\",\"status\":\"succeeded\"}",
  "response_body_truncated": false,
  "response_content_type": "application/json",
  "correlation": { "request_id": "req_xyz", "idempotency_key": "idem_abc", "trace_id": "…", "span_id": "…" },
  "duration_ms": 42,
  "redaction": { "applied": true, "patterns": ["PAN"], "spec_aware": false,
                 "fields": [ { "part": "request", "path": "/card_number", "pattern": "PAN",
                               "props": { "type": "string", "length": 19, "containsLowerCase": false,
                                          "containsUpperCase": false, "containsDigits": true,
                                          "containsASCIIControlChars": false, "containsASCIIPrintableChars": true,
                                          "containsASCIIExtendedChars": false } } ] }
}
```

Three **store-owned, read-API-only** fields ride on the STORED call (`GET /api/calls`, `GET
/api/calls/…`) and are store-owned facts: a flag body carries them as part of the call record (the CP ignores them — its schema tolerates them via `additionalProperties: true`) and no reader may treat them as CP-verified:

| Field | Type | Meaning |
|---|---|---|
| `drifted` | bool | THIS call produced a per-call finding (`live-vs-spec` on REST, `output_mismatch` on MCP). Set by the store on every occurrence, and on insert from `validated: "drifted"`. Omitted when false. |
| `validated` *(2026-09-07)* | string | The drift processor's own verdict, from `flanj.validated` (§2): `"clean"` \| `"drifted"` \| `"not-validated"` \| `"unknown"` (the record reached the store carrying no verdict). **Absent** on a row stored before verdicts were recorded — the ONLY case a reader may fall back to inferring coverage from the contract list. |
| `validated_reason` *(2026-09-07)* | string | The gate that stopped validation, from `flanj.validated.reason` (§2). Present iff `validated` is `"not-validated"`. |

The collector UI's contract chip reads `validated`, never the contract list: a call with no verdict
is `not checked`, never CONFORMING.

One more stored field is **local-only** — unlike the three above, the flag relay strips it from the
call it sends, so it never reaches the CP:

| Field | Type | Meaning |
|---|---|---|
| `service_name` *(2026-09-19)* | string | The emitting service's `service.name` (the caller on an outbound record, the service the call reached on an inbound one), from the record's OTLP resource (§2). It names this org's own services — internal topology — so it stays on the collector: shown on the Overview MCP lines and as a Traffic filter. Omitted when the resource carried none. |

**`integration` on the wire** *(2026-09-19)*. Locally, the collector stores and keys an inbound call by
its service name (§2, the `flanj.integration` row), and so does a finding raised against the org's own
`self_spec_path` contract. A service name never leaves the collector, so the flag relay sends
`integration` = `"self"` on both the call and the finding (§4) whenever the call is inbound
(`direction` `"server"`) or the finding came from the self spec. That is the value the wire carried
before. Outbound and MCP keys, which are host slugs, cross unchanged.

---

## 4. `Finding` (detection → local UI → CP thread artifact)

JSON Schema: [`v1/finding.schema.json`](./v1/finding.schema.json). Sample: [`v1/sample-finding.json`](./v1/sample-finding.json).

```jsonc
{
  "schema_version": 1,
  "id": "0191e8c4-…",
  "kind": "live-vs-spec",                    // | "version-diff"
  "change_kind": null,                       // additive+optional: WHAT moved —
                                             // wording | input | output | catalog | value | observed_failure.
                                             // Set on MCP findings only; absent on the HTTP kinds and on
                                             // findings from older collectors.
  "severity": "breaking",                    // breaking | warning | info — info NEVER crosses the org
                                             //   boundary: not flaggable on any kind
  "via_dispatch": null,                      // additive+optional: the dispatcher tool a call went
                                             //   through, when detection attributed it to the INNER tool
  "source": null,                            // additive+optional: "tools_list" (absent = this) | "search_result"
                                             //   (defs a discovery meta-tool returned) | "toolset_enable" (a
                                             //   session's listing right after a toolset was enabled)
  "completeness": null,                      // additive+optional: "complete" | "partial" (a search result is
                                             //   partial by nature — never a source of removals)
  "integration": "acme-payments",
  "endpoint": "POST /v1/charges",
  "field_path": "amount",
  "location": "$.response.body.amount",
  "expected": "type=integer",
  "actual": "type=string (\"1200\")",
  "rule": "type-mismatch",                   // undocumented-enum | missing-required |
                                             // response-property-type-changed | response-property-enum-value-removed | …
  "spec_version_from": null,                 // set for kind=version-diff
  "spec_version_to": null,
  "signature": "acme-payments|POST /v1/charges|live-vs-spec|type-mismatch|amount", // dedup key: one finding per drift
  "occurrence_count": 1247,                  // how many calls carried this SAME drift (a drift is per-endpoint, not per-call)
  "source_call_id": "0191e8c4-…",            // a REPRESENTATIVE drifted call (null for kind=version-diff)
  "first_seen": "2026-08-18T08:00:01.000Z",
  "last_seen": "2026-08-18T09:14:33.000Z",
  "detected_at": "2026-08-18T08:00:01.000Z",
  "detail": "Response field `amount` is a string; spec declares integer."
}
```

**A drift is per endpoint, not per call:** the collector collapses all calls sharing a `signature`
(edge + endpoint + kind + rule + field) into ONE finding — incrementing `occurrence_count` + `last_seen`
rather than emitting duplicates. The flag's `idempotency_key` derives from the `signature`, so re-flagging the
same drift returns the existing thread. Individual calls stay marked drifted in Traffic.

Detection is **technical adherence only** — fields/types/shapes/enums. Never business/economic
correctness (pricing, quantities, business rules). `live-vs-spec` via `kin-openapi` `openapi3filter.ValidateResponse`
(`MultiError: true`). `version-diff` via `oasdiff` checker (`Level=ERR` → `severity="breaking"`,
change-id → `rule`), computed once at spec load, `source_call_id=null`.

**MCP finding kinds — v0.5 (Step C)** (additive; produced by the collector's MCP detection path from
the §2 MCP call / `contract_snapshot` records — same `Finding` shape, same per-signature dedup;
`endpoint` = the tool name, i.e. the contract `Operation.id`):

| `kind` | Evidence | Cross-org flaggable? |
|---|---|---|
| `output_mismatch` | a `tools/call` `structuredContent` violates the tool's declared `outputSchema` (same JSON Schema validator + token-aware redaction rules as `live-vs-spec`; captured props of whole-value redactions decide type/length constraints). A tool with **no** `outputSchema` never produces one. `source_call_id` = a representative call carrying the MCP correlation keys. | **Yes** (severity `breaking`) |
| `definition_change` | two consecutive observed `tools/list` snapshots differ; one finding per (edge, tool, `rule`, `field_path`) from the definition-diff classifier. `expected`/`actual` = before/after schema **fragments**; `spec_version_from`/`to` = abbreviated snapshot content hashes; both snapshot timestamps in `detail`; `source_call_id` = null. `change_kind` is `wording` \| `input` \| `output` \| `catalog`. | **Yes for `warning` and `breaking`** — and never automatic: a human presses the flag control on the row. **`info` is local only**: the UI shows it, the Flag control is unavailable on it, and the CP rejects a flag whose finding severity is `info`. Wording changes stay flaggable (they are `warning`), as they have been since qfix2-2026-08-26. |
| `stale_client` | the consumer's agent called a tool absent from the **current** `tools/list` (`rule` = `tool-not-listed`) or with arguments violating the **current** `inputSchema`. Consumer-side. `change_kind` `observed_failure`, severity **`breaking`** (the call the agent just made fails; it was `warning`). | **No — local only, ever**, at any severity. No flag control anywhere. |
| `input_rejection` *(2026-09-17)* | a `tools/call` was rejected with JSON-RPC **`-32602`** (`flanj.mcp.error.code`) on arguments whose **shape** (top-level keys and JSON types) previously **succeeded** on the same tool. A `-32602` on a never-accepted shape is the caller's own problem and is not reported. `rule` = `arguments-previously-accepted-rejected`; `change_kind` `observed_failure`; severity `breaking`; `source_call_id` = the rejected call. Provider-side. | **Yes.** |
| `value_change` *(2026-09-17)* | a field of the tool's OBSERVED responses held one value **format** for 5 consecutive responses and then another in the same family for 3 in a row: timestamp (ISO-8601 / date / epoch seconds / epoch milliseconds), ID (UUID / prefixed / numeric), enum casing (UPPER_CASE / lower_case), number representation (integer / decimal — the units story). A field whose format never settles, or that carries free text, never fires. `rule` = `value-format-changed`; `expected` / `actual` = the old / new format; `change_kind` `value`; severity `warning`. Needs no declared schema. | **Yes.** |

**`change_kind` by kind**: `definition_change` → `wording` \| `input` \| `output` \| `catalog` (from the rule
table below); `output_mismatch` → `output`; `value_change` → `value`; `stale_client` and `input_rejection` →
`observed_failure`. Absent on `live-vs-spec` / `version-diff`, whose vocabulary this field does not describe.

**INFO stays local**, on **every** kind: the local UI shows an `info` finding with no Flag
control, the collector's relay answers `403 not_flaggable`, and the control plane answers `400 info_not_flaggable`
to a flag whose `finding.severity` is `info`. Only `warning` and `breaking` become a thread.

**Servers behind discovery meta-tools.** Detection reads tool definitions out of search RESULTS
the agent already received (baked adapters for known patterns plus the operator's
`flanjdrift.mcp_meta_adapters`; the collector never probes). Those definitions are a per-tool contract with
`source: "search_result"`, `completeness: "partial"`: a tool re-observed with a different definition is a
`definition_change` on that tool; absence from a later result is never a removal. A dispatcher call is judged as
its inner tool **only** when the inner name exactly matches a tool the same server returned in a search result
this collector recorded; its findings are keyed to the inner tool and carry `via_dispatch`, and so is the **stored
call** (2026-09-18): `mcp_tool_name` and `route` name the inner tool and `via_dispatch` names the dispatcher, while its
request body stays the literal dispatcher call so a provider can reproduce it exactly. Any other name stays on the
dispatcher — nothing is inferred from the shape of a call.

The tools a search returned are also a **contract row of their own** (its own catalogue row, listed in the local UI): integration
`<integration>:search`, format `mcp`, source `search_result` — partial by definition — written when the learned
catalog changes and seeded back on restart and to tiered fronts, exactly like an observed `tools/list`. A tool
that the complete listing does not declare but the partial catalog does (a searched tool called directly) is
judged against that definition and is never a `stale_client`.

**Toolset enable** (adapters' `enable_tools`, baked: `enable_toolset`). A `tools/list` observed within two minutes
after a successful enable call on the same edge is that **session's** catalog, not the server's: tools the baseline
also lists are compared like any re-observation (findings carry `source: "toolset_enable"`, `completeness:
"partial"`), tools only it lists join the partial catalog, the baseline is not replaced, and nothing is reported
removed — so the next session's plain listing is not read as the toolset's removal.

The two flaggable MCP kinds also carry the additive **optional** `snapshot_observed_at` (ISO date-time): the `tools/list` observation backing the finding — the **current** snapshot's `ObservedAt` for `output_mismatch`, the **after** snapshot's for `definition_change`; absent on other kinds and on findings from older collectors (readers must tolerate its absence).

`definition_change` findings also carry the additive **optional** `snapshot_observed_from` (ISO date-time): the **previous** snapshot's observation time — the structured sibling of `snapshot_observed_at` (which stays the **after** snapshot), so readers never parse the `detail` prose for the before-time; absent on other kinds and on findings from older collectors (readers must tolerate its absence).

**`definition_change` rule ids (the definition-diff classifier's table — direction-aware since 2026-09-13;
two-axis since 2026-09-17).**
`rule` is the classifier's stable id; the drift signature hangs off it, so one field can never carry two rows for
one change. `expected` / `actual` are the before / after **fragments**. The single implementation is the
collector's public `contract/diff` package; nothing re-implements a rule.

Every row carries **two independent fields**: a **kind** — what moved — and a
**severity** — how much it matters. They replace the single `class` label (BREAKING / NON_BREAKING /
DESCRIPTION), which mixed the two: "DESCRIPTION" named a kind while "BREAKING" named a severity, so a reader
could not ask one question without answering the other. **A kind never implies a severity** (`input` spans INFO
and WARNING; `output` spans WARNING and BREAKING; `catalog` spans INFO and BREAKING), and severity comes from
this table and nowhere else. The classifier emits `INFO` / `WARNING` / `BREAKING`; the wire's `severity` is the
lower-case `info` / `warning` / `breaking`, mapped at exactly one point (`internal/drift.severityOf`).

**Additive changes are not reported** — a new tool, a new optional param, a widened input type, a newly declared
output schema. They are real, and `contract/diff` still returns them so a caller can see the whole diff, but they
carry no severity, `reported` is false, and they must never reach a published count.

| `rule` | side | when | kind | severity |
|---|---|---|---|---|
| `operation-removed` | tool | a tool left | `catalog` | **BREAKING** |
| `operation-added` | tool | a tool arrived | `catalog` | *additive — not reported* |
| `operation-renamed` | tool | a removed tool and an added one share an identical `inputSchema` that declares ≥1 property; `expected` = old name, `actual` = new name | `catalog` | **BREAKING** |
| `catalog-moved-behind-meta-tools` | tool | a server's catalog moved behind discovery meta-tools. **ONE event for the move, never one removal per hidden tool.** Not emitted by `contract/diff` (it is a property of *how* a catalog was obtained, which only the snapshot/expansion layer knows); the id lives in the classifier's table so the vocabulary has one home. The watch emits it from its expansion layer; the collector from its `tools/list` comparison, when a listing that is **only** discovery meta-tools (at least one search or dispatcher among them) follows one that listed tools it now hides — the hidden tools' removals are not reported, and only a tool both listings carry can have changed. | `catalog` | **INFO** |
| `description-changed` | tool | wording only. **At most ONE per tool per day**, and diffs that are whitespace-, case- or punctuation-only are ignored entirely (`diff.TrivialWordingChange`). The per-day cap is applied by whatever aggregates a day's comparisons — `contract/diff` sees one pair of revisions and has no notion of a day. In the collector it holds by construction: a tool's description change has ONE signature, so every later edit bumps that finding rather than adding one. | `wording` | **WARNING** |
| `input-required-property-added` | input | a new argument callers **must** send — the one input cell above INFO | `input` | **WARNING** |
| `input-optional-property-added` | input | a new argument callers may send | `input` | *additive — not reported* |
| `input-required-property-removed` | input | an argument callers were required to send is gone | `input` | **INFO** |
| `input-optional-property-removed` | input | an argument callers could send is gone. `detail` still states the consequence — whether the **new** schema declares `additionalProperties: false` (a caller still sending it now fails validation) or tolerates the stray argument — but the severity is the same either way. | `input` | **INFO** |
| `input-property-renamed` | input | a removed property with a **same-typed** twin added under a name that normalises to the same key (camelCase / snake_case / kebab-case fold together: `branchId` = `branch_id` = `branch-id`) — ONE row, never a removal plus an addition; `expected` = `{name, schema}` of the old, `actual` of the new, `field_path` = the OLD path. `detail` = `renamed <old> → <new>`. | `input` | **INFO** (the same parameter under a new spelling, even when the new name is required) |
| `output-property-renamed` | output | as above, on the declared response, when the removed property was **required** | `output` | **BREAKING** |
| `output-optional-property-renamed` | output | as above, when the removed property was **optional** — ONE row, never an `output-optional-property-removed` plus an unreported addition (it reuses the input rename pairing) | `output` | **WARNING** — the grade of that property being removed, which is what it is to a consumer still reading the old name |
| `input-type-widened` | input | the type set gained members (`string` → `["string","null"]`; `integer` → `number`): every argument sent today still validates | `input` | *additive — not reported* |
| `input-type-narrowed` | input | the type set lost members (`["integer","string"]` → `integer`; `number` → `integer`): a caller sending the dropped type now fails | `input` | **INFO** |
| `input-type-changed` | input | the type set was replaced (`integer` → `string`) | `input` | **INFO** |
| `output-property-type-widened` | output | the type set gained members (`number` → `["number","string"]`): the consumer may receive a type it never handled | `output` | **BREAKING** |
| `output-property-type-narrowed` | output | the type set lost members (`["null","string"]` → `string`, or → `["null"]`) | `output` | **BREAKING** |
| `output-property-type-changed` | output | the type set was replaced (`number` → `string`) | `output` | **BREAKING** |
| `input-enum-value-removed` | input | values left the enum and none arrived; `expected` = `{"enum": [removed…]}`, `actual` = `{"enum": []}` | `input` | **INFO** |
| `output-enum-value-removed` | output | as above, on the declared response | `output` | **BREAKING** |
| `input-enum-value-added` | input | values arrived and none left; a caller's existing value still validates | `input` | *additive — not reported* |
| `output-enum-value-added` | output | values arrived and none left; `expected` = `{"enum": []}`, `actual` = `{"enum": [added…]}`. A consumer may now receive a value it has no branch for — worth telling them; nothing they already handle stopped being valid. (It was NON_BREAKING here while the classifier's prose claimed every output cell was breaking.) | `output` | **WARNING** |
| `input-enum-value-replaced` | input | values left AND arrived in one revision: ONE row, `expected` = the removed, `actual` = the added | `input` | **INFO** |
| `output-enum-value-replaced` | output | as above (`["city","region"]` → `["city","state"]`) — follows the REMOVED half, the worse one | `output` | **BREAKING** |
| `output-required-property-removed` | output | a value consumers were promised is gone | `output` | **BREAKING** |
| `output-optional-property-removed` | output | a declared value consumers were **not** promised is gone. **Newly covered**: this cell used to emit nothing at all, so a provider could stop declaring a field consumers were reading and the diff stayed silent. | `output` | **WARNING** |
| `output-optional-property-added` | output | a new value consumers may receive | `output` | *additive — not reported* |
| `output-schema-removed` | output | the output contract as a whole left — every declared field at once | `output` | **BREAKING** |
| `output-schema-declared` | output | the output contract as a whole arrived: a surface that was never declared promises more, not less | `output` | *additive — not reported* |

Type sets are compared as sets (union order is not semantic) under JSON Schema's one subtype relation — every
`integer` is a `number` — and two sets that accept the same values (`["number","integer"]` vs `["number"]`) are
no change. Adding or dropping the `enum` keyword itself is outside the table.

*Why the whole INPUT family is INFO.* A caller controls their own arguments. When a provider moves the input
surface, that is information the caller acts on in their own code — not a promise broken to them — so the rule id
and the `detail` carry what changed and the severity stays INFO. The one exception is a new **required**
parameter (WARNING): the caller's existing, previously-valid call now fails until they change it. Input widening
is Postel's law and is not reported at all: whatever a caller sends today still validates.

*Why every output TYPE cell is BREAKING.* Output widening is its mirror image: the consumer's parser may now
meet a type it never handled. Output **narrowing** follows the posture this contract already froze for REST
version-diffs, where `response-property-enum-value-removed` is promoted to `breaking` because *a value the
consumer's code may branch on has silently disappeared* — that sentence applies to a type member verbatim.
`["null","string"]` → `["string"]` turns the consumer's null branch into dead code; `["null","string"]` →
`["null"]` makes the field's data disappear; the classifier cannot tell the harmless case from the severe one
without a business judgement it is not allowed to make (technical adherence only), so the direction is recorded
under its own id and the class stays conservative. A reader that wants to triage the two differently has the
id to do it with.

The evidence rule (**amended qfix2-2026-08-26**) is enforced **server-side in the collector
relay**, not only by UI absence: `POST /api/flag` for a `stale_client` finding returns
`403 {"error":"not_flaggable"}`, and such findings never reach the CP. `stale_client` is consumer-side —
it has no flag control on any surface and never gains one.

**The amendment: a DESCRIPTION-only `definition_change` is flaggable.** Its evidence passes the
"verifiable in the provider's own systems" bar — it is the provider's own published `tools/list` text:
two content-hashed snapshots with observation timestamps, which they verify by reading their own two
versions. What failed the bar was the *claim*, not the evidence, so the flag carries the claim honestly
("you're asking whether the change was intended", not "this is a bug"). Nothing auto-flags: the flag is a
human act on the row.

**Call-less flags (qfix2-2026-08-26, WIDENED v1p4-2026-09-08).** A `definition_change` has
`source_call_id: null` by nature, so the flag that carries it has **no `call`**. That was the original,
kind-scoped relaxation; it left every *other* kind refused with `400 finding_has_no_call` even when the
operator had written out what they were asking, which is a flag control that 400s — worse than no control.

The rule is now the honest one, and it holds for every kind: **`call` is OPTIONAL when the request carries a
non-empty `message`, or when the finding is call-less by nature (`definition_change`); it is REQUIRED
otherwise.** A thread must carry *something* — evidence, or words; a flag with neither is still
`400 {"error":"finding_has_no_call"}`. The `definition_change` arm is the qfix2 rule kept verbatim, so a
snapshot-only flag with an empty message stays legal exactly as before; what the message arm adds is every
*other* kind. `finding` is
optional outright, which is what makes a **message-only thread started from an edge** possible: an edge is
a registrable domain, not a drift, so no finding exists to attach. Such a thread is created with
`evidence_count: 0` and renders as a question — message plus both org names, with a trust strip that
claims no redacted evidence, because none is attached. All of it lives in
[`v1/cp-flag-request.schema.json`](./v1/cp-flag-request.schema.json). Server-side `not_flaggable`
refusals for consumer-local kinds (`stale_client`) are **unchanged** — those never cross the boundary with
or without a message. This supersedes the earlier deferral and the qfix2 kind list.

**`spec_version_to` is the evidence version of a `definition_change`** (existing field; its consumer-facing
semantics are stated here for the first time — no wire change). It is the AFTER snapshot's content hash, and
it changes whenever the provider publishes a *further* change to the same field, while `signature`
(`integration|endpoint|kind|rule|field_path`) stays identical across successive changes. Any reader that
persists per-finding local state — in v0.1a that is the collector's local acknowledgement — MUST key it on
`signature` **plus** `spec_version_to`, so a new change can never inherit the state of the old one. For
occurrence-counted kinds (`live-vs-spec` `type-mismatch`, `output_mismatch`) recurrence is expected and the
key stays `signature` alone.

**Matching is EQUALITY, and absence is never a wildcard** (the migration rule — normative). A persisted
record that carries **no** evidence version does **not** match a `definition_change`, which always carries an
after-hash: records written before this key existed therefore re-surface **un-acknowledged** rather than
matching every future change forever. A reader MUST NOT treat a missing evidence version as "matches any",
and MUST NOT fall back to the `signature`-only key for a `definition_change` when the stored version is
absent. Fail safe is re-surfacing, never staying silently acknowledged — the whole point of the key is that
the state a person set can only ever cover the evidence that was on screen when they set it.

---

## 5. Control-plane API — collector-facing subset  *(v0.1a, 2026-08-23)*

Only the endpoints the **collector** calls are specified here: the collector is a public repo and implements
the client side of these. The control plane's own surface (thread pages, sessions, identity, notifications,
DLP) is not part of this document.

**Model:** the collector **Connects** once per deployment (`register` → a per-deployment **collector key**,
persisted in the collector's store, never logged, never per-pod) and the contact confirms their email with one
click. *(2026-09-14)* **Connect needs no pre-issued token**: a NEW collector registers with no credential at
all — the contact's confirmation click is the consent — and `cp_deploy_token` is optional (an operator or
per-account token, when one is used, is still accepted exactly as before). **The key is the collector's
permanent identity; its `collector_name` is a label, unique within the contact's workspace and changeable.**
A reconnect after a restart is the same call with the same name and the stored key; a rename is that call with
a new name. Creating or sharing a thread requires the collector key **and** a
confirmed contact (`412 {"error":"not_connected"|"contact_unconfirmed"}`); viewing local data never does. Every
thread records the key that created it; thread-scoped mutations need that key (`403 wrong_origin` otherwise).
Thread state is `open | closed` (reopenable); `turn` labels are derived. Errors are JSON `{ "error", "message" }`.

OpenAPI-style summary; JSON Schema for the flag request body:
[`v1/cp-flag-request.schema.json`](./v1/cp-flag-request.schema.json) (`invitee_email` optional, ignored;
`finding` optional; `call` optional when `message` is non-empty or the kind is `definition_change` — §4).

### `POST /api/v1/collectors/register`  (no credential for a NEW collector · Bearer `cp_deploy_token` · Bearer collector key)
`{ "contact_email", "collector_name", "contact_display_name"?, "local_ui_url"?, "consumer_display_name"? }` → `201`
(or `200` on the idempotent replay / reconnect / rename) `{ "collector_id", "collector_public_id", "collector_key"
(returned once), "collector_name", "collector_name_derived", "contact_status": "pending"|"confirmed" }`. The CP
emails the contact a one-click confirmation that names the collector; `local_ui_url` is display-only (the CP never
calls the collector) and is what that mail — and the workspace's Collectors view — shows as the collector's address.

*(2026-09-19)* **The collector no longer names its organization.** A workspace — every collector whose contact is
one person — has ONE display name, the name other organizations see on its threads and in the mail Flanj sends
them. The first collector of a workspace names it: the contact is asked for it on the confirmation page the mailed
link opens, never on the collector, and a later collector joins the named workspace without being asked. The
collector reads the name back from `GET …/me` (`workspace_display_name`) and keeps its own copy, so it can show it
while the control plane is unreachable. `consumer_display_name` is therefore **deprecated**: optional, and it names
nothing. The control plane still accepts it from an older collector, where it only seeds a derived
`collector_name` when none is sent.

*(2026-09-14)* **Which credential the call carries decides what it may do.** With NONE it is a NEW collector, and
only that: it never reads, renames or re-mails an existing one — a `collector_name` already held in the contact's
workspace answers `409 collector_name_taken`, never an update. With the collector's own KEY it is the record the key
names: the same name is a reconnect (no error, no duplicate; the same email = the resend it always was), a
different name is a RENAME (the record is updated and nothing else about it changes — no mail), a different email
is a new pending contact. With a deploy token the pre-2026-09-14 semantics are unchanged (the replay key is the
contact email). **`collector_name` is REQUIRED from a collector that knows the field** — the Connect panel will
not send without one — and tolerated absent from an older collector, which cannot know it: the CP then derives
one from the org name it sent (`<org>`, `<org> 2`, …; `Collector` when it sent none) and answers
`collector_name_derived: true`. Unique within the
workspace, compared casefolded with punctuation collapsed; ≤80 characters after cleaning; a SENT blank is `400`. A
name — the collector's or the org's — that reads as a link or an email address is `400 invalid_name` (both are
printed in the confirmation mail), and `local_ui_url` must be ONE absolute http(s) address with no credentials
(`400 bad_request`). An anonymous caller is bounded per IP and per recipient address (the CP's own contract states
the numbers); a refused call creates nothing and mails nothing.

### `GET /api/v1/collectors/me`  (Bearer collector key)
`{ "collector_id", "collector_public_id", "collector_name", "workspace_display_name", "consumer_display_name",
"contact_email", "contact_display_name", "contact_status", "registered_at", "confirmed_at" }` — the local UI polls
this for the Connect panel; `collector_name` is the stored name after any rename, so the panel shows what the
workspace sees. `workspace_display_name` *(additive, 2026-09-19)* is the workspace's display name — `null` until a
contact has confirmed — and what the collector shows as its organization; it may change (the workspace renames
itself), so a collector re-reads it rather than keeping the first value forever. `consumer_display_name` is
deprecated: whatever an older collector sent at register, or `""`.

### `POST /api/v1/flags`  (Bearer collector key)
Headers: `X-Flanj-Collector-Version`, `X-Flanj-Schema-Version`.
```jsonc
// request
{ "idempotency_key": "flag_0191…",           // re-flag returns the existing thread
  "consumer_display_name": "Acme Consumer Ltd", // DEPRECATED 2026-09-19 — OPTIONAL, and IGNORED for naming:
                                             //   the control plane names the sender from the flagging
                                             //   workspace's display name (one per workspace across all its
                                             //   collectors). A collector may send its copy of that name,
                                             //   or omit the field.
  "provider_display_name": "Acme Payments",  // DEPRECATED 2026-09-19 — OPTIONAL, accepted and IGNORED.
                                             //   Collectors no longer send it. The control plane names the
                                             //   provider itself: the workspace that has proved ownership
                                             //   of the flagged host's domain, else a verified directory
                                             //   name, else the domain. A consumer's guess never names the
                                             //   other side.
  "message": "Your /v1/charges response returns amount as a string; spec says integer.",
  "evidence_origin": "finding",              // OPTIONAL, additive (slice2-2026-08-28): "finding" (default when
                                             //   absent — the promoted call's bodies start withheld from the
                                             //   provider on the thread page) | "call_pick" (the operator chose
                                             //   the call while looking at it — starts revealed). Unknown values
                                             //   read as "finding" (tolerant). Collectors need not send it.
  "allowed_domains": ["acme.com"],          // OPTIONAL, additive (2026-09-14): who may OPEN the thread — email domains …
  "allowed_emails": null,                   //   … OR specific addresses. At most one of the two is a list; both null means
                                             //   anyone holding the link. See "Who may open a thread" below.
  "provider_host": "api.acme.test",         // OPTIONAL, additive (v1p4-2026-09-08): the edge's observed host, for a
                                             //   thread with NO call. The domain is the anchor, so a message-only
                                             //   thread names the edge it was started from and the thread page can
                                             //   resolve a verified directory name (or the bare domain) instead of
                                             //   an unattributed asserted one. IGNORED when `call` is present.
  "call": { /* RedactedCall — OPTIONAL when `message` is non-empty, or on a definition_change (v1p4-2026-09-08) */ },
  "finding": { /* Finding — OPTIONAL; absent for a message-only thread started from an edge */ } }
// response 201 (200 on replay → "status":"existing", same thread_public_id, fresh token)
{ "thread_id": "0191…", "thread_public_id": "<opaque>",
  "thread_url": "https://<peek-origin>/t/<thread_public_id>#k=<token>",   // the Thread link the consumer copies
  "peek_url": "<deprecated alias of thread_url>", "magic_token": "<deprecated alias>", "state": "open", "status": "created" }
// 400 finding_has_no_call  — `call` missing, `message` empty, and the kind is not call-less by nature
// 400 allowed_domains_empty | invalid_domain | allowed_emails_empty | invalid_email — a list with nothing usable
//                            in it, or an entry that is not a bare domain / one plain address (or not a string)
// 400 access_conflict      — `allowed_domains` and `allowed_emails` are both lists
// 400 bad_request          — `allowed_domains` / `allowed_emails` is neither a list nor null, or has more than 20 entries
// 403 not_flaggable        — a consumer-local kind (`stale_client`), with or without a message
// 400 info_not_flaggable   — `finding.severity` is `info`: INFO never crosses the org
//                            boundary, on any kind; the CP's standard one-sentence error body
// 412 not_connected | contact_unconfirmed
```
`thread_public_id` is random/opaque/≥128-bit/URL-safe; the bearer `<token>` (≥128-bit CSPRNG, stored hashed)
lives ONLY in the URL fragment; expiry slides on every reply (30d, 90d hard cap, 30d after close). The CP sends no
email on flag — the consumer pastes the link where the two teams already talk.

**Who may open a thread — `allowed_emails` / `allowed_domains`** *(additive, 2026-09-14)*. The Thread link is
still the capability: without it nobody reaches the thread. What changes is what the link alone shows. A thread is
open in one of three ways, chosen when it is created:

| Open to | Fields | Who opens it |
|---|---|---|
| specific people | `allowed_emails: ["dana@acme.com"]`, `allowed_domains: null` | a reader who confirms one of those exact addresses |
| a domain | `allowed_domains: ["acme.com"]`, `allowed_emails: null` | a reader who confirms an address at one of those domains, or a subdomain of one |
| anyone with the link | both `null` | anyone holding the link — how every thread behaved before the fields existed |

On the first two, a reader who opens the link sees only the two organisation names and a request to confirm their
address; the call, the finding and the conversation are withheld until they do, and a confirmed address the thread
does not allow is refused with one sentence. On a domain thread that sentence names the domains; on a thread open to
specific people it names nobody.

- **Both fields absent read as anyone with the link.** A collector shipped before them could not have asked its
  operator, so its threads stay open to the link. That is the compatibility default, not a recommendation.
- **A collector that knows the fields always sends both**, the unchosen one as `null`, so `null` records the
  operator's explicit choice. The collector's own relay refuses a create that carries neither (`400 missing_fields`).
- At most one of the two may be a list (`400 access_conflict`). Entries are trimmed and lower-cased — a domain also
  loses a leading `@` and a trailing `.`, and an address written `Name <addr>` is read as the address — and duplicates
  fold; at most 20 (`400 bad_request`, as is a value that is neither a list nor null). An empty list is
  `400 allowed_emails_empty` / `allowed_domains_empty`; an entry that is not one plain address / a bare domain is
  `400 invalid_email` / `invalid_domain`.
- The side that shared the thread keeps all of it regardless of the choice.

## 6. Redaction contract (the security floor)

Governed by TWO golden files — **the files, not shared code, are the contract**:

- [`v1/redaction-vectors.json`](./v1/redaction-vectors.json) — scalar/recognizer-level vectors (text in → text
  out + fired patterns).
- [`v1/redaction-fixtures.json`](./v1/redaction-fixtures.json) — the structured **cross-language parity**
  battery: many PAN formats, PANs in arrays / nested / undocumented fields / object keys / as JSON numbers,
  base64 (std, url-safe, whole-body, embedded in a form value), inbound request bodies (high PII density,
  batches, form-encoded), truncated and malformed bodies, the negatives that must survive (non-Luhn 16-digit
  id, last4, amounts, timestamps, UUIDs/hashes, national-format phones, bare 9-digit ids, bad-checksum IBAN,
  base64 without PII / of binary), idempotency, report order, and the poisoned-spec enhancer cases.

Two implementations conform: `@flanj/redaction-patterns` (TypeScript, published from `sdk`; the CP consumes
the same package for reply DLP) and the collector's Go `internal/redact`. **Both test suites run both files.**
For `json` fixtures both entry points are asserted — structural `redact(value)` and the text path over the
serialized body, parsed back — by **deep equality** (the parity oracle; serializer differences cannot mask or
fake a redaction difference); `text` fixtures are **byte-for-byte**. So the same PAN redacts identically in both
languages, and a divergence fails CI in whichever repo drifted.

**Engine.** The floor is **composed hardened validators behind our own swappable interface** (a per-pattern
`Recognizer` returning confirmed spans in one scalar; a `Redactor` that recurses arbitrary nested structures and
returns a redacted clone + fired patterns; engine choice is per recognizer). Detection decisions are made by
vetted offline validators — TS: `validator` (`isLuhnNumber`, `isEmail`, `isIBAN`) + `libphonenumber-js`; Go:
`govalidator` (`IsEmail`, `IsSSN`) + `nyaruka/phonenumbers` + own Luhn / mod-97 IBAN — **not hand-rolled regex,
and not a third-party redaction engine**. The wrapper (ours, identical in every language) owns: deep traversal
of objects/arrays/(Go) structs with keys scanned and PAN-as-number / CVV-under-key handled; **Luhn gating** (the
PAN gate is pure Luhn, never brand/BIN-gated); **base64 decode-then-scan** (whole encoded run → token); separator
normalization (detect on digits, redact the original span; a PAN next to other separated digit groups is still
found); the `⟦REDACTED:<TYPE>⟧` token; recognizer **anchoring** (word-boundary anchored; phone requires a `+`
country code and goes through the phone library); **form-urlencoded** decode-then-scan; tolerant handling of
truncated/malformed JSON (every byte is scanned by some path); and **zero external calls** (lint-banned +
sentinel-tested in TS; source-banned `IsExistingEmail`/`IsDialString`/`IsHost` + `go list -deps` audit in Go).
The text path rewrites ONLY the scalars that fired, so JSON formatting/key order/untouched literals are preserved
and every language emits the same bytes. Design reference: `sdk/REDACTION.md`.

The floor applies to **every captured body — inbound and outbound, any edge classification** (`internal` edges
are metadata-only, so there is nothing to redact; but any body that IS captured is always floor-scanned first).

**Mandatory floor** (all fire by default; application order TOKEN, CVV, IBAN, PHONE, PAN, EMAIL, SSN, then IP
when enabled; **report order** PAN, EMAIL, IBAN, SSN, PHONE, CVV, TOKEN, IP):

| id | Matches | Token |
|---|---|---|
| `PAN` | 13–19 digit runs (separators stripped, ≤ 5 groups, word-anchored) **passing Luhn**; also a 13–19 digit JSON integer passing Luhn | `⟦REDACTED:PAN⟧` |
| `EMAIL` | email-shaped candidate confirmed by the email validator | `⟦REDACTED:EMAIL⟧` |
| `IBAN` | ISO-13616, electronic or print format, registry + mod-97 validated | `⟦REDACTED:IBAN⟧` |
| `SSN` | US SSN `###-##-####` (format-anchored; no checksum exists) | `⟦REDACTED:SSN⟧` |
| `PHONE` | international (`+` country code) numbers in common separated formats, validated against phone metadata | `⟦REDACTED:PHONE⟧` |
| `CVV` | 3–4 digits as the value of a `cvv`/`cvv2`/`cvc`/`cvc2`/`csc`/`security_code` (optionally `card_`-prefixed) key — string or number — or `cvv=123` / `cvc: 456` in text | `⟦REDACTED:CVV⟧` |
| `TOKEN` | Bearer tokens, JWTs (header validated as a JSON object), `sk_`/`pk_`-style `live`/`test` keys | `⟦REDACTED:TOKEN⟧` |
| `IP` *(optional)* | IPv4/IPv6 | `⟦REDACTED:IP⟧` |

Token delimiters are `U+27E6`/`U+27E7` (`⟦ ⟧`) — regex-stable, won't collide with JSON/text.

**Schema-aware enhancer.** Our own spec-driven layer ABOVE the floor (`enhance(value, spec)` / Go
`redact.Enhance`): `spec` is a list of `{path, type}` (dot path, `[]` = every array element, `type` a floor id).
It is applied to the floor's **output** and may only ADD tokens: it only replaces a string/number leaf carrying no
token; a scalar the floor touched is immutable to it; unresolvable paths/unknown types are ignored. The
never-subtract law (every floor token survives unchanged at its path) is asserted by every suite over every
fixture × every spec.

**Drift interplay.** The floor runs BEFORE drift detection, so drift only ever sees redacted bodies. A spec
constraint can "fail" solely because a value became a `⟦REDACTED:…⟧` token (pattern/format/enum/length on the
token string; integer→string after the PAN-as-number rewrite). The drift detector therefore SKIPS any schema
error whose offending scalar carries a token — redacted means *unknown*, never *violated* — and the skip is
scalar-only, so container-level errors (e.g. required-missing) still fire; the floor never adds or removes
keys, so those are genuinely the provider's. For whole-value redactions the record carries the ORIGINAL
value's captured properties (`redaction.fields`, §2/§3 — type, length in code points, character classes;
non-reversible by design), and drift validates the DECIDABLE constraints against them: `type` and
`minLength`/`maxLength` violations on a redacted field are real findings again; undecidable constraints
(`pattern`/`format`/`enum`) and token-carrying values without a matching record keep skipping (which also
covers older SDKs in the compatibility window that emit no fields).

**Invariants (tested by the vectors + fixtures):**
1. **Add-only:** schema-aware redaction may only *add* redaction above the floor, never subtract
   (poisoned-spec safety).
2. **Idempotent:** `redact(redact(x)) == redact(x)`; a `⟦REDACTED:…⟧` token is inert to re-scan
   (the collector's defense-in-depth pass never double-wraps the SDK's output).
3. **Redact before store/emit:** the raw buffer is dropped after redaction; no raw body is ever set as an
   attribute, stored, or transmitted — even transiently.
4. **Zero external calls:** the floor is a pure function of its input.
5. **Parity:** TypeScript, Go and Python produce identical results on the shared fixtures.

---

## 7. Versioning & backward compatibility

- Every payload carries `schema_version` (and OTLP carries `flanj.capture.version`). Readers are
  **tolerant**: unknown fields are ignored.
- **Additive-first (expand/contract):** new fields are optional; producers/consumers adopt independently;
  the old shape is removed only after all sides migrate. No flag-day.
- **The CP is the long-lived side and must stay backward-compatible.** Self-hosted collectors/SDKs lag
  arbitrarily, so CP ingest accepts any `schema_version ≥ floor`, up-converts older payloads, and rejects
  only below-floor with an actionable "upgrade your collector" message. The CP is tested against **every
  in-window contract version**, not just the latest.
- Breaking change ⇒ bump the contract major, add a new `vN/` dir here, keep the CP dual-reading through a
  deprecation window, and require the integration compatibility matrix to be green for the whole set before promotion.

---

## 8. Collector runtime config (frozen keys)

**Removed 2026-09-14 — `integration_id`, `self_integration_id`.** The collector's identity is its
`collector_name`, given in the Connect panel (mandatory, unique within the contact's workspace,
changeable), not a config key; the Overview headline names the collector, and
a call's or finding's `integration` (§3/§4) is derived by the collector at ingest (§2, the
`flanj.integration` row), and never came from this key. A self-spec finding is keyed locally by the inbound
call's service name (the constant `self` until 2026-09-19); on the wire it is still `self` (§3). A config that still carries either key
boots with a one-line warning naming it; the value is ignored.

**Removed 2026-08-31 — `spec_path`, `spec_v2_path`, `peer_host`.** Provider
OpenAPI contracts are no longer configured: they are **uploaded in the collector
UI**, bound to exactly one provider host, stored locally, and read by the drift
processor from the store at runtime. A config file could not carry fifty
providers' documents, a mounted file went stale the moment the vendor published,
and the singular `spec_path`/`peer_host` pair gave 50 discovered edges detection
on exactly one — with `peer_host` unset, one document silently validated *every*
outbound call. An uploaded contract never leaves the collector. `self_spec_path`
is deliberately unaffected: one document per deployment, not one per vendor.

| Key | Meaning |
|---|---|
| `provider_display_name` *(optional, deprecated 2026-09-19)* | **Accepted and ignored.** It was the fallback provider name sent on a flag; the collector no longer sends any provider name, because the control plane names the provider from verified domain ownership (see `POST /api/v1/flags`, §5). Kept as a key only so an existing config keeps loading. It stopped naming an edge on 2026-08-31: the `contract` tier names edges from the uploaded document's `info.title`, keyed by the bound host's registrable domain. |
| `consumer_display_name` *(optional, deprecated 2026-09-19)* | **Accepted and ignored.** It was the org name sent at Connect and on a flag. A workspace is now named by its contact when its first collector's contact is confirmed, and the collector reads that name from `GET /api/v1/collectors/me` (§5). Kept as a key only so an existing config keeps loading. |
| `self_spec_path` *(optional)* | the OpenAPI spec THIS org publishes as a provider; validates INBOUND (server-direction) responses against the org's own contract |
| `cp_base_url` | control-plane base URL the COLLECTOR's own requests go to (register/me, flags, thread routes, the syncs). May be in-network — a docker service name, a k8s Service, a VPC-private ingress — because only the collector has to reach it; see `cp_public_url` for the browser's side |
| `cp_public_url` *(optional, flanjui — 2026-09-07)* | the control-plane origin the OPERATOR'S BROWSER can open: the base of the local UI's one link out, `dashboard_url` on the collector's `GET /api/connect` (emitted only while Connected; the collector composes the `/d` path). A link built from an in-network `cp_base_url` is dead off-host — an early defect. Unset: the link falls back to `cp_base_url` only when its host is not obviously non-public (loopback / private IP / single-label / `.local` `.internal` `.svc` `.cluster.local` `.test` `.example`-style suffixes), otherwise `dashboard_url` is omitted and the UI keeps the pill a Settings button. Validated at boot: absolute `http(s)` URL, no credentials. Never logged. The `/api/connect` shape is unchanged — `dashboard_url` was already optional; only its presence rule narrowed |
| `cp_deploy_token` *(optional since 2026-09-14)* | a deploy token for Connect — an operator's or a per-account one. **Not needed**: with it unset a new collector registers with no credential and the contact's confirmation click is the consent; the per-deployment collector key the CP returns is what authorizes every later call either way. Set it only when an operator wants registrations partitioned by a token they hold |
| `body_cap_bytes` | capture cap, default `16384` |
| `backend` | store backend: `sqlite` (default — embedded, one pod per db file) or `postgres` (shared external DB; multiple collector pods may write to one database) |
| `db_path` | sqlite file path, required iff `backend=sqlite`; MUST be on a persistent volume. With `backend=postgres` it is the OPTIONAL one-shot migration source: if the file exists at start, pinned calls + findings + edges are imported and the file is renamed `<db_path>.migrated`; import failure aborts start |
| `dsn` | postgres connection string, required iff `backend=postgres`; use `${env:…}` interpolation for credentials — the collector only ever logs it redacted |
| `window_max_rows` / `window_max_bytes` | rolling-window ceilings (with `backend=postgres`, set identically on every pod sharing the database) |
| `finding_sync` | *(flanjui, bool, default `true` — slice2-2026-08-28)* the background finding-shape sync to the CP (`POST /api/v1/findings`, §5): every 15s, when a collector key exists, the UI extension sends the current findings **shape-only** (`expected`/`actual`/`detail` stripped at source). `false` disables that POST entirely. It governs the findings egress ONLY — the directory-name refresh that rides the same ticker has its own switch, `directory_sync` (v1p1-2026-08-31). |
| `directory_sync` | *(flanjui, bool, default `true` — v1p1-2026-08-31)* the background **directory refresh** — the vendor-directory down-channel, which carries display names today: on the SAME 15s ticker as `finding_sync`, when a collector key exists, the UI extension does one conditional full-table **GET** of the directory display-name table (`GET /api/v1/directory`, ETag / `If-None-Match`; `304` = no-op) and stores the response for local name resolution. It is a pure FETCH — this collector's own edges, peer hosts and domains are **never sent** in this request, there is no per-edge or per-miss lookup, and nothing about the deployment's dependency graph leaves on this path. `false` disables the refresh only (the findings sync is unaffected); names still resolve offline from the **baked directory seed** shipped in the collector image, **plus whatever table was already pulled** — turning the switch off stops future fetches, it does not clear a table fetched earlier, so a previously-connected collector keeps serving those names (frozen, and going stale) until the store is reset. The "your edges are never sent" promise above is about THIS request and stays exactly as stated; **edge registration is a different path** (`edge_sync`, below) — separately gated, separately disclosed, and never reached by turning this one on. |
| `edge_sync` | *(flanjui, bool, default `true` — v1p2-2026-09-09)* **edge registration** — the third leg of the same 15s ticker, gated independently of the other two. Once a collector key exists, each unique **EXTERNAL** edge is registered to the CP (`POST /api/v1/edges/sync`, §5) as `{registrable_domain, direction, first_seen, last_seen}` and nothing else: no calls, no bodies, no payloads, no peer hosts, no call or drift counts. **Internal edges never leave** — the same classification that keeps them off `GET /api/edges` keeps them off the wire, asserted on the marshalled bytes. Nothing is sent before Connect. `false` disables the registration only (`finding_sync` and `directory_sync` are unaffected); with all three false no ticker starts at all. Unlike `directory_sync`, this leg DOES send something about this collector's edges — which is why the Connect panel discloses it before the operator Connects. |
| `store_pod_endpoint` *(optional, flanjdrift)* | base URL of the store pod's `spec_endpoint`. Set on a FRONT of the tiered topology only: a front runs drift but owns no store, so this is how uploaded contracts — and, since 2026-09-07, the observed MCP `tools/list` snapshots every front forwards, i.e. the org-wide MCP baseline — reach it. Empty everywhere else, where the co-located store is read in-process |
| `store_pod_token` *(optional, flanjdrift)* | bearer token presented to `store_pod_endpoint`; must match the store pod's `spec_token`. Use `${env:…}`; never logged |
| `spec_endpoint` *(optional, flanjstore)* | intra-cluster bind for the read-only CONTRACT endpoint (`GET /internal/contracts`, `GET /internal/contracts/doc`). Set on the tiered topology's STORE POD so fronts can read provider contracts bound to an edge: uploaded OpenAPI documents and observed MCP `tools/list` snapshots (format `mcp`, since 2026-09-07). `GET /internal/contracts/doc` takes an optional `format` (`openapi` | `mcp`, additive): without it the endpoint serves the REST contract when one exists for the integration, else the MCP catalogue. Contracts only — no calls, no findings, no settings, never the self contract — and never the loopback UI |
| `spec_token` *(optional, flanjstore)* | bearer token `spec_endpoint` requires. Use `${env:…}`; never logged |
| `ui_endpoint` | localhost bind for the UI extension, default `127.0.0.1:5335` |
| `otlp_endpoint` | OTLP receiver bind, default `0.0.0.0:4318` |

*Tiered topology (N front collectors → one store pod, collector `docs/STORE.md` "Topologies") adds NO
flanj keys: a front's forwarding is the core OpenTelemetry `otlphttp` exporter (upstream's keys —
`endpoint` = the store pod's base URL, e.g. `http://flanj-store:4318`), and the store pod runs the
same `flanjstore` / `flanjui` keys above. Role is chosen by which config file runs.*

*The `flanjstore` EXPORTER (2026-09-07) likewise adds no flanj keys: it accepts upstream's
`sending_queue` and `retry_on_failure` sections (the exporterhelper keys `otlphttp` has), both ON by
default — a bounded in-memory queue (64 MiB, rejecting when full) and backoff retry (1s→30s, 15 min)
on a failed store write — so `flanjstore: {}` keeps every default. The store is idempotent on
`flanj.call.id` and on the finding id, so a retried batch never duplicates a row or an
`occurrence_count`.*

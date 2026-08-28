# Vinifera — Cross-repo Contracts (v1)

**This directory is the single source of truth for every cross-component contract in Vinifera.**
All four repos (`sdk`, `collector`, `control-plane`, `e2e`) key off the fixtures and schemas here.
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

Log record `body` is empty; all data is in **attributes**. Attribute keys (carrier-agnostic — identical
if ever moved to a span event):

| Attribute | Type | Notes |
|---|---|---|
| `vinifera.capture.version` | string | `"1"` — the redaction/capture manifest version |
| `vinifera.record.type` | string | `"call"` — one completed call. Since v0.5 (Step B) the SDK also emits `"contract_snapshot"` (an observed MCP `tools/list` — see the MCP block below); older collectors drop the unknown type silently, so the addition is forward-compatible with no `schema_version` bump. The collector reuses the same pipeline for its own internal record types `"finding"` and `"spec_info"` (below), which also cross the front→store hop of the tiered topology. |
| `vinifera.direction` | string | `"client"` = egress (org is **consumer**) \| `"server"` = ingress (org is **provider**) |
| `vinifera.peer.host` | string | the OTHER end's host[:port] — egress: the destination; ingress: the caller/source. The edge key. |
| `vinifera.peer.addr` *(optional)* | string | the peer's socket address (IP) when the socket layer exposed one — egress: the resolved remote address; ingress: `socket.remoteAddress` (behind a proxy: the last hop's). Transport detail for display/debugging; NEVER an identity or edge key. Omitted when unknown. |
| `vinifera.edge.class` | string | `"external"` \| `"internal"` — classification of `peer.host`, byte-identical in SDK + collector. **Internal** = RFC1918 (10/8, 172.16-31/12, 192.168/16) / loopback (127/8, `::1`) / unspecified (`::`) / link-local (169.254/16, `fe80::/10`) / ULA (`fc00::/7`) / a name ending `.svc.cluster.local`·`.internal`·`.local` / single-label host. `::ffff:` IPv4-mapped addresses are unmapped first. Else **external**. v0.5 (Step B) adds the additive value `"local-process"`: a stdio MCP server (see the MCP block below) — bodies ARE captured + redacted (a local MCP process usually fronts an external API; the contract is the server's), unlike `internal` which stays metadata-only. |
| `vinifera.capture.bodies` | bool | `true` on external edges (bodies present) · `false` on internal (bodies OMITTED — internal is metadata-only, classified out of surfacing). |
| `vinifera.integration` | string | the integration id, e.g. `"acme-payments"` (may be derived from `peer.host` when auto-discovered) |
| `vinifera.http.method` | string | `"POST"` |
| `vinifera.http.route` | string | templated if known (`"/v1/charges"`) else path |
| `vinifera.http.target` | string | redacted path+query |
| `vinifera.http.url.full` | string | redacted absolute URL |
| `vinifera.http.status_code` | int | `200` |
| `vinifera.http.request.content_type` | string | |
| `vinifera.http.request.body` | string | **redacted**, capped at `body_cap_bytes` |
| `vinifera.http.request.body.truncated` | bool | |
| `vinifera.http.request.headers` | string | **redacted** JSON, allowlisted keys only |
| `vinifera.http.response.content_type` | string | |
| `vinifera.http.response.body` | string | **redacted**, capped |
| `vinifera.http.response.body.truncated` | bool | |
| `vinifera.http.response.headers` | string | **redacted** JSON, allowlisted |
| `vinifera.corr.request_id` | string | from `x-request-id`/`x-correlation-id` |
| `vinifera.corr.idempotency_key` | string | from `idempotency-key` |
| `vinifera.corr.trace_id` | string | hex |
| `vinifera.corr.span_id` | string | hex |
| `vinifera.http.duration_ms` | int | |
| `vinifera.redaction.applied` | bool | |
| `vinifera.redaction.patterns` | string | JSON array of fired pattern ids, e.g. `["PAN"]` |
| `vinifera.redaction.spec_aware` | bool | v0 = `false` |
| `vinifera.redaction.fields` *(optional)* | string | JSON array of whole-value body redactions with the ORIGINAL value's captured properties; omitted when empty. Entries `{part: "request"\|"response", path, pattern, props}` — `path` an RFC 6901 JSON Pointer into that body; `props` = `{type: "string"\|"number", length (Unicode code points of the original scalar text), integer? (numbers), containsLowerCase (a-z), containsUpperCase (A-Z), containsDigits (0-9), containsASCIIControlChars (≤0x1F or 0x7F), containsASCIIPrintableChars (0x20–0x7E), containsASCIIExtendedChars (>0x7F)}`. Sorted by part (request first) then path. Non-reversible by design (never anything that narrows the value). Emitted only for whole-value redactions (the scalar became exactly one token); span-in-text redactions, redacted keys, form pairs and non-JSON text carry no fields. Purpose: the collector's drift detector validates the DECIDABLE constraints (type, min/maxLength) of redacted fields instead of skipping them (§6 Drift interplay). |

**MCP tool-call records — v0.5 (Step B)** (additive; emitted by the SDK's MCP client wrapper,
`instrumentMcpClient`, one record per completed `tools/call`): the SAME `"call"` record shape as HTTP,
with the tool riding the method/route slots — `vinifera.http.method` = `"tools/call"`,
`vinifera.http.route` = `vinifera.http.target` = `"/<tool.name>"`, `vinifera.http.url.full` =
`"mcp://<peer.host>/<tool.name>"` (synthetic, display only). The request body is the `tools/call`
**arguments** (JSON); the response body is **`structuredContent`** when present (content-type
`application/json`), else the `content[]` text items joined with newlines (`text/plain` — the floor's
text path parses-then-traverses JSON text, so a PAN inside stringified JSON is caught structurally,
not by a regex). Headers are `"{}"`; `vinifera.http.status_code` is **omitted** (MCP has none —
`vinifera.mcp.is_error` carries the outcome); every body is floor-redacted at source with
`redaction.fields` captured exactly as on HTTP. `vinifera.peer.host` = the streamable-HTTP endpoint
host[:port], or `serverInfo.name` for a stdio server (edge class `"local-process"`); a streamable-HTTP
peer classified `internal` stays metadata-only as ever. Additive attributes:

| Attribute | Type | Notes |
|---|---|---|
| `vinifera.transport` | string | `"mcp"`. Absent on HTTP records (absent = HTTP). |
| `vinifera.mcp.tool.name` | string | the called tool — the operation id downstream detection matches against the contract (`Operation.id` / `Match.toolName`). |
| `vinifera.mcp.is_error` | bool | the CallToolResult's `isError` (also `true` when the call itself rejected). Feeds the error-rate metric; never a finding on its own. |
| `vinifera.mcp.server.name` *(optional)* | string | `serverInfo.name` from initialize, when the client surfaces it. |
| `vinifera.mcp.server.version` *(optional)* | string | `serverInfo.version`. |
| `vinifera.mcp.protocol.version` *(optional)* | string | the negotiated MCP protocol version. |
| `vinifera.mcp.session.id` *(optional)* | string | `Mcp-Session-Id` when the transport exposes one (2025-11-25 line; absent on 2026-07-28 stateless). |
| `vinifera.corr.client_request_id` *(optional)* | string | the JSON-RPC id observed on the client's OWN outgoing message — **client-generated**: it appears in the provider's logs only if they log it. Rendered as "JSON-RPC id (client-generated)", and never merged into `vinifera.corr.request_id`, which stays **provider-issued only** (the v0.5 client wrapper sees no HTTP response headers and therefore emits none). |

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
| `vinifera.capture.version` | string | `"1"` |
| `vinifera.record.type` | string | `"contract_snapshot"` |
| `vinifera.transport` | string | `"mcp"` |
| `vinifera.direction` | string | `"client"` |
| `vinifera.peer.host` / `vinifera.edge.class` / `vinifera.integration` | | as on MCP call records (same edge key). |
| `vinifera.mcp.contract_snapshot` | string | **floor-redacted** JSON `{"tools":[…], "serverInfo"?, "protocolVersion"?, "capabilities"?}`. Each tool carries exactly the ToolDef wire keys `name` / `description` / `inputSchema` / `outputSchema` / `annotations` (decodable by the collector's `contract.ParseToolsList`); schemas are the server's own words, passed verbatim — a tool without `outputSchema` keeps none (the honest "no output contract declared" state, never synthesized). `capabilities` carries `{tools:{listChanged}}` when the client surfaces it. |
| `vinifera.mcp.tool.count` | int | tools in the snapshot. |
| `vinifera.mcp.server.name` / `vinifera.mcp.server.version` / `vinifera.mcp.protocol.version` *(optional)* | string | server identity, when surfaced. |
| `vinifera.redaction.applied` / `vinifera.redaction.patterns` | bool / string | the floor pass over the snapshot JSON (usually nothing fires; the floor still runs — every captured payload is floor-scanned first, §6). |

Canonical example: [`v1/golden-otlp-mcp-snapshot.json`](./v1/golden-otlp-mcp-snapshot.json).

**Collector-internal record types** (never emitted by the SDK; produced by the collector's drift
processor and consumed by its store exporter — in the tiered topology they travel from a front
collector to the store pod over the core `otlphttp` exporter as ordinary OTLP log records):

| `vinifera.record.type` | Carries | Notes |
|---|---|---|
| `"finding"` | `vinifera.finding.json` = the whole §4 Finding as JSON | Appended after the calls of the batch that produced it. Order is NOT load-bearing: the store pins a finding's source call whichever arrives first (late pin). |
| `"spec_info"` | `vinifera.spec_info.json` = the loaded contract's metadata `{integration, role ("provider"\|"self"), peer_host?, format, title?, version?, docs_url?, endpoints?, loaded_at}`; the raw spec document in the log record **body as bytes** (may be empty) | Emitted by a collector that loaded a spec: on the first batch after start, then at most every 10 minutes, so a store pod (or a freshly wiped store) converges. Idempotent upsert keyed by `integration`. |

A store that does not recognise a record type drops it silently (it never becomes a call: the
store exporter requires method + route). Unknown types are therefore forward-compatible; upgrade
the store pod before the fronts.

Canonical example: [`v1/golden-otlp-call.json`](./v1/golden-otlp-call.json) — one drifting charge call
(response `amount` returned as the string `"1200"` where the spec declares integer), card number already
redacted. The collector's contract test ingests this and must deterministically emit the expected Finding.

**Header allowlist** (everything else dropped, not redacted): `content-type`, `content-length`,
`x-request-id`, `x-correlation-id`, `idempotency-key`, `user-agent`, `date`. `authorization`, `cookie`,
`set-cookie` are **redacted to a `⟦REDACTED:TOKEN⟧` token if present in an allowlisted context**, never emitted raw.

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

---

## 4. `Finding` (detection → local UI → CP thread artifact)

JSON Schema: [`v1/finding.schema.json`](./v1/finding.schema.json). Sample: [`v1/sample-finding.json`](./v1/sample-finding.json).

```jsonc
{
  "schema_version": 1,
  "id": "0191e8c4-…",
  "kind": "live-vs-spec",                    // | "version-diff"
  "severity": "breaking",                    // breaking | warning | info
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
| `definition_change` | two consecutive observed `tools/list` snapshots differ; one finding per (edge, tool, `rule`, `field_path`) from the definition-diff classifier. `expected`/`actual` = before/after schema **fragments**; `spec_version_from`/`to` = abbreviated snapshot content hashes; both snapshot timestamps in `detail`; `source_call_id` = null. | **Yes — every class**: BREAKING (severity `breaking`), NON_BREAKING (`info`) and, since **qfix2-2026-08-26**, DESCRIPTION (`rule` = `description-changed`, severity `warning`). Never automatic: a human presses the flag control on the row. |
| `stale_client` | the consumer's agent called a tool absent from the **current** `tools/list` (`rule` = `tool-not-listed`) or with arguments violating the **current** `inputSchema`. Consumer-side; severity `warning`. | **No — local only, ever.** No flag control anywhere. |

The two flaggable MCP kinds also carry the additive **optional** `snapshot_observed_at` (ISO date-time): the `tools/list` observation backing the finding — the **current** snapshot's `ObservedAt` for `output_mismatch`, the **after** snapshot's for `definition_change`; absent on other kinds and on findings from older collectors (readers must tolerate its absence).

`definition_change` findings also carry the additive **optional** `snapshot_observed_from` (ISO date-time): the **previous** snapshot's observation time — the structured sibling of `snapshot_observed_at` (which stays the **after** snapshot), so readers never parse the `detail` prose for the before-time; absent on other kinds and on findings from older collectors (readers must tolerate its absence).

The evidence rule (v0.5 spec §6, **amended qfix2-2026-08-26**) is enforced **server-side in the collector
relay**, not only by UI absence: `POST /api/flag` for a `stale_client` finding returns
`403 {"error":"not_flaggable"}`, and such findings never reach the CP. `stale_client` is consumer-side —
it has no flag control on any surface and never gains one.

**The amendment: a DESCRIPTION-only `definition_change` is flaggable.** Its evidence passes the
"verifiable in the provider's own systems" bar — it is the provider's own published `tools/list` text:
two content-hashed snapshots with observation timestamps, which they verify by reading their own two
versions. What failed the bar was the *claim*, not the evidence, so the flag carries the claim honestly
("you're asking whether the change was intended", not "this is a bug"). Nothing auto-flags: the flag is a
human act on the row.

**Call-less flags (qfix2-2026-08-26).** A `definition_change` has `source_call_id: null` by nature, so the
flag that carries it has **no `call`**: `call` is optional in
[`v1/cp-flag-request.schema.json`](./v1/cp-flag-request.schema.json) when `finding.kind` is
`definition_change`, and required for every other kind — a call-less `output_mismatch` (or any
call-evidenced kind) is still refused with `400 {"error":"finding_has_no_call"}`. The thread renders the
two published snapshots as its evidence and no failing-call section. This supersedes the v0.5 §7 deferral.

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
DLP) is a private contract maintained alongside the control plane and is not part of this document.

**Model:** the collector **Connects** once per deployment (`register` with the install-time `cp_deploy_token`
→ a per-deployment **collector key**, persisted in the collector's store, never logged, never per-pod) and the
contact confirms their email with one click. Creating or sharing a thread requires the collector key **and** a
confirmed contact (`412 {"error":"not_connected"|"contact_unconfirmed"}`); viewing local data never does. Every
thread records the key that created it; thread-scoped mutations need that key (`403 wrong_origin` otherwise).
Thread state is `open | closed` (reopenable); `turn` labels are derived. Errors are JSON `{ "error", "message" }`.

OpenAPI-style summary; JSON Schema for the flag request body:
[`v1/cp-flag-request.schema.json`](./v1/cp-flag-request.schema.json) (`invitee_email` optional, ignored;
`call` optional for `definition_change` only — §4).

### `POST /api/v1/collectors/register`  (Bearer `cp_deploy_token`)
`{ "consumer_display_name", "contact_email", "contact_display_name"?, "local_ui_url"? }` → `201` (or `200` on the
idempotent replay with the same deploy token + contact) `{ "collector_id", "collector_public_id", "collector_key"
(returned once), "contact_status": "pending"|"confirmed" }`. The CP emails the contact a one-click confirmation;
`local_ui_url` is display-only (the CP never calls the collector).

### `GET /api/v1/collectors/me`  (Bearer collector key)
`{ "collector_id", "collector_public_id", "consumer_display_name", "contact_email", "contact_display_name",
"contact_status", "registered_at", "confirmed_at" }` — the local UI polls this for the Connect panel.

### `POST /api/v1/flags`  (Bearer collector key)
Headers: `X-Vinifera-Collector-Version`, `X-Vinifera-Schema-Version`.
```jsonc
// request
{ "idempotency_key": "flag_0191…",           // re-flag returns the existing thread
  "consumer_display_name": "Acme Consumer Ltd",
  "provider_display_name": "Acme Payments",  // OPTIONAL — else the CP humanizes call.integration
  "message": "Your /v1/charges response returns amount as a string; spec says integer.",
  "call": { /* RedactedCall — OMITTED for a call-less definition_change (qfix2-2026-08-26) */ },
  "finding": { /* Finding */ } }
// response 201 (200 on replay → "status":"existing", same thread_public_id, fresh token)
{ "thread_id": "0191…", "thread_public_id": "<opaque>",
  "thread_url": "https://<peek-origin>/t/<thread_public_id>#k=<token>",   // the Thread link the consumer copies
  "peek_url": "<deprecated alias of thread_url>", "magic_token": "<deprecated alias>", "state": "open", "status": "created" }
// 400 finding_has_no_call  — `call` missing on any kind except definition_change
// 412 not_connected | contact_unconfirmed
```
`thread_public_id` is random/opaque/≥128-bit/URL-safe; the bearer `<token>` (≥128-bit CSPRNG, stored hashed)
lives ONLY in the URL fragment; expiry slides on every reply (30d, 90d hard cap, 30d after close). The CP sends no
email on flag — the consumer pastes the link where the two teams already talk.

### Thread routes  (Bearer collector key; `403 wrong_origin` unless the key created the thread)
| Route | Body | Response |
|---|---|---|
| `POST /api/v1/threads/{threadId}/peek-links` | `{ "revoke_existing"?: bool, "card_endpoint_detail"?: bool }` | `201 { "thread_url", "peek_url" (alias), "magic_token" (alias), "expires_at", "revoked": n }` — Replace thread link |
| `POST /api/v1/threads/{threadId}/peek-links/revoke` | — | `200 { "revoked": n }` (respondent tokens + sessions; owner access untouched) |
| `POST /api/v1/threads/{threadId}/close` · `/reopen` | — | `200 { "state", "closed_at", "reopened_at" }` |
| `POST /api/v1/threads/{threadId}/handoff` | — | `201 { "owner_url": "https://<peek-origin>/o/<public_id>#o=<handoff>", "expires_at" }` — 10-min single-use, opened in the browser; never stored, never logged |
| `GET /api/v1/threads/{threadId}/summary` | — | `{ "id", "thread_public_id", "state", "closed_at", "reopened_at", "turn": "waiting_on_provider"\|"provider_replied"\|"fix_reported"\|"replied_while_closed", "provider_display_name", "endpoint", "evidence_count", "opened_count", "knock_count", "message_count", "last_reply_at", "fixed_claim": {"display_name","at"}\|null, "link": {"status": "active"\|"replaced"\|"expired", "expires_at"}, "archived" }` — the local UI's Threads list polls this (state only; the conversation is read on the CP) |

---

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

Two implementations conform: `@vinifera/redaction-patterns` (TypeScript, published from `sdk`; the CP consumes
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
and not a third-party redaction engine**. The wrapper (ours, identical in both languages) owns: deep traversal
of objects/arrays/(Go) structs with keys scanned and PAN-as-number / CVV-under-key handled; **Luhn gating** (the
PAN gate is pure Luhn, never brand/BIN-gated); **base64 decode-then-scan** (whole encoded run → token); separator
normalization (detect on digits, redact the original span; a PAN next to other separated digit groups is still
found); the `⟦REDACTED:<TYPE>⟧` token; recognizer **anchoring** (word-boundary anchored; phone requires a `+`
country code and goes through the phone library); **form-urlencoded** decode-then-scan; tolerant handling of
truncated/malformed JSON (every byte is scanned by some path); and **zero external calls** (lint-banned +
sentinel-tested in TS; source-banned `IsExistingEmail`/`IsDialString`/`IsHost` + `go list -deps` audit in Go).
The text path rewrites ONLY the scalars that fired, so JSON formatting/key order/untouched literals are preserved
and both languages emit the same bytes. Design reference: `sdk/REDACTION.md`.

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
never-subtract law (every floor token survives unchanged at its path) is asserted by both suites over every
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
5. **Parity:** TS and Go produce identical results on the shared fixtures.

---

## 7. Versioning & backward compatibility

- Every payload carries `schema_version` (and OTLP carries `vinifera.capture.version`). Readers are
  **tolerant**: unknown fields are ignored.
- **Additive-first (expand/contract):** new fields are optional; producers/consumers adopt independently;
  the old shape is removed only after all sides migrate. No flag-day.
- **The CP is the long-lived side and must stay backward-compatible.** Self-hosted collectors/SDKs lag
  arbitrarily, so CP ingest accepts any `schema_version ≥ floor`, up-converts older payloads, and rejects
  only below-floor with an actionable "upgrade your collector" message. The CP is tested against **every
  in-window contract version**, not just the latest.
- Breaking change ⇒ bump the contract major, add a new `vN/` dir here, keep the CP dual-reading through a
  deprecation window, and require the `e2e` compatibility matrix to be green for the whole set before promotion.

---

## 8. Collector runtime config (frozen keys)

| Key | Meaning |
|---|---|
| `integration_id` | the integration being observed, e.g. `acme-payments` |
| `provider_display_name` *(optional)* | human name of the provider whose API is observed, e.g. `Acme Payments`; sent on the flag so the peek/thread names the provider. Defaults to a humanized `integration_id`. |
| `consumer_display_name` *(optional)* | human name of this consumer org, e.g. `Acme Consumer Ltd`; sent on the flag. |
| `spec_path` | path to the provider OpenAPI spec (v1) mounted into the collector; validates OUTBOUND (client-direction) calls |
| `spec_v2_path` *(optional)* | a newer spec, enables the version-diff finding |
| `peer_host` *(optional)* | scopes `spec_path` validation to the one discovered edge with this peer host; unset, every outbound (client-direction) call is validated against the loaded spec |
| `self_spec_path` *(optional)* | the OpenAPI spec THIS org publishes as a provider; validates INBOUND (server-direction) responses against the org's own contract |
| `self_integration_id` *(optional)* | labels self-spec findings (default `self`); must differ from `integration_id` |
| `cp_base_url` | control-plane base URL for the flag POST |
| `cp_deploy_token` | static Bearer token (the only outbound auth) |
| `body_cap_bytes` | capture cap, default `16384` |
| `backend` | store backend: `sqlite` (default — embedded, one pod per db file) or `postgres` (shared external DB; multiple collector pods may write to one database) |
| `db_path` | sqlite file path, required iff `backend=sqlite`; MUST be on a persistent volume. With `backend=postgres` it is the OPTIONAL one-shot migration source: if the file exists at start, pinned calls + findings + edges are imported and the file is renamed `<db_path>.migrated`; import failure aborts start |
| `dsn` | postgres connection string, required iff `backend=postgres`; use `${env:…}` interpolation for credentials — the collector only ever logs it redacted |
| `window_max_rows` / `window_max_bytes` | rolling-window ceilings (with `backend=postgres`, set identically on every pod sharing the database) |
| `ui_endpoint` | localhost bind for the UI extension, default `127.0.0.1:5335` |
| `otlp_endpoint` | OTLP receiver bind, default `0.0.0.0:4318` |

*Tiered topology (N front collectors → one store pod, collector `docs/STORE.md` "Topologies") adds NO
vinifera keys: a front's forwarding is the core OpenTelemetry `otlphttp` exporter (upstream's keys —
`endpoint` = the store pod's base URL, e.g. `http://vinifera-store:4318`), and the store pod runs the
same `viniferastore` / `viniferaui` keys above. Role is chosen by which config file runs.*

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
HTTP call**. The SDK redacts at source **before** the record is constructed; raw bodies never reach OTLP.

Log record `body` is empty; all data is in **attributes**. Attribute keys (carrier-agnostic — identical
if ever moved to a span event):

| Attribute | Type | Notes |
|---|---|---|
| `vinifera.capture.version` | string | `"1"` — the redaction/capture manifest version |
| `vinifera.record.type` | string | `"call"` (findings reuse the pipeline as `"finding"`) |
| `vinifera.direction` | string | `"client"` = egress (org is **consumer**) \| `"server"` = ingress (org is **provider**) |
| `vinifera.peer.host` | string | the OTHER end's host[:port] — egress: the destination; ingress: the caller/source. The edge key. |
| `vinifera.peer.addr` *(optional)* | string | the peer's socket address (IP) when the socket layer exposed one — egress: the resolved remote address; ingress: `socket.remoteAddress` (behind a proxy: the last hop's). Transport detail for display/debugging; NEVER an identity or edge key. Omitted when unknown. |
| `vinifera.edge.class` | string | `"external"` \| `"internal"` — classification of `peer.host`, byte-identical in SDK + collector. **Internal** = RFC1918 (10/8, 172.16-31/12, 192.168/16) / loopback (127/8, `::1`) / unspecified (`::`) / link-local (169.254/16, `fe80::/10`) / ULA (`fc00::/7`) / a name ending `.svc.cluster.local`·`.internal`·`.local` / single-label host. `::ffff:` IPv4-mapped addresses are unmapped first. Else **external**. |
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
correctness (FX/fees/spreads). `live-vs-spec` via `kin-openapi` `openapi3filter.ValidateResponse`
(`MultiError: true`). `version-diff` via `oasdiff` checker (`Level=ERR` → `severity="breaking"`,
change-id → `rule`), computed once at spec load, `source_call_id=null`.

---

## 5. Control-plane API — collector-facing subset

Only the endpoints the **collector** calls are specified here: the collector is a public repo and implements
the client side of these. The control plane's own surface (peek pages, session/token handling, thread
lifecycle, DLP) is a private contract maintained alongside the control plane and is not part of this
document.

OpenAPI-style summary; JSON Schema for the flag request body:
[`v1/cp-flag-request.schema.json`](./v1/cp-flag-request.schema.json).

### `POST /api/v1/flags`  (collector UI-extension → CP)
Auth: `Authorization: Bearer <cp_deploy_token>`. Headers: `X-Vinifera-Collector-Version`, `X-Vinifera-Schema-Version`.
```jsonc
// request
{
  "idempotency_key": "flag_0191…",           // re-flag returns the existing thread
  "consumer_display_name": "Acme Consumer Ltd",
  "provider_display_name": "Acme Payments",  // OPTIONAL — who the flag is about. If omitted the CP
                                             // humanizes call.integration (e.g. acme-payments → Acme Payments).
  "invitee_email": "api-support@provider.test",
  "message": "Your /v1/charges response returns amount as a string; spec says integer.",
  "call": { /* RedactedCall */ },
  "finding": { /* Finding */ }
}
// response 201
{ "thread_id": "0191…", "peek_url": "https://<peek-origin>/t/<thread_public_id>#k=<token>", "magic_token": "<opaque>", "status": "created" }
// response 200 (idempotent replay) → { …, "status": "existing" }  (same thread_public_id, fresh token)
```

### `POST /api/v1/threads/{threadId}/peek-links`  (collector UI-extension → CP; Bearer `cp_deploy_token`)
Copy-link + regenerate: mints a fresh channel-tagged token on the SAME per-thread link.
```jsonc
// request — all fields optional
{ "channel": "slack",              // link|slack|whatsapp|telegram|teams|other (email only via the flag path)
  "revoke_existing": true,          // regenerate: revoke every outstanding token first (immediate)
  "card_endpoint_detail": false }   // per-thread consumer toggle: endpoint+finding type on the unfurl card
// response 201
{ "peek_url": "https://<peek-origin>/t/<public_id>#k=<token>", "magic_token": "<opaque>",
  "channel": "slack", "expires_at": "…", "revoked": 1 }
```

### `POST /api/v1/threads/{threadId}/peek-links/revoke`  (Bearer `cp_deploy_token`)
Revokes every outstanding token on the thread — immediate, including live peek sessions minted
from them. → `{ "revoked": n }`

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

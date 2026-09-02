# CLAUDE.md — `@flanj/sdk`

Guidance for Claude Code (and engineers) working in this repo.

## What this repo is

The **Flanj SDK**: a thin OpenTelemetry-JS distribution that adds HTTP **request/response body capture**
and **redaction-at-source**, then exports one OTLP log record per call to the collector. Since v0.5 (Step B)
it also instruments the **MCP client** (`instrumentMcpClient` — transport-independent, out-of-band, both
`@modelcontextprotocol` package lines as optional peers; see `src/mcp/CLAUDE.md`). It is the first
step of the pipeline (**capture** → detect → surface → flag → peek). Public, **Apache-2.0** — keep it
pristine (legal and compliance teams at regulated organizations inspect it; no copyleft/source-available deps,
prefer Apache/MIT/BSD/ISC).

It also publishes **`@flanj/redaction-patterns`** (Apache), the shared redaction floor the control plane
reuses for reply-box DLP.

## Role in the system

`app → (flanj SDK captures + redacts) → OTLP/HTTP :4318 → collector`. OTel auto-instrumentation gives
spans/metadata but **not** bodies; bodies are the non-redundant evidence that make drift detection possible.
Redaction happens here, at the call site, **before** anything is attached or exported.

## Stack & commands

- TypeScript, Node 23, Yarn 4. OTel-JS `@opentelemetry/api ^1.9`, SDK+instrumentation `^0.221`.
- `yarn install` · `yarn build` · `yarn test` (unit + redaction vectors + OTLP contract + pack manifest) ·
  `yarn test:watch` · `yarn lint` · `bash scripts/smoke-pack.sh` (packs, installs the tarball into a scratch app).
- **Publishing goes through `yarn npm publish`** (it rewrites the `workspace:` protocol; plain `npm publish` does not),
  and `@flanj/redaction-patterns` must be published **first** — the SDK tarball depends on it by plain version.

## Layout

```
src/
  index.ts                         # the distro entrypoint (start(): register both instrumentations + OTLP logs exporter)
  register.ts                      # the `./register` zero-code entry (see package.json exports) — KEEPS the handle
  otlp-endpoint.ts                 # endpoint resolution: FLANJ_/OTEL_ precedence + base-URL -> /v1/logs normalization
  export-failure-warning.ts        # wraps the exporter so the FIRST export failure prints one line (no diag hijack)
  flush-on-exit.ts                 # beforeExit + SIGTERM/SIGINT flush, bounded, then re-raise the signal
  version.ts                       # package version (OTLP scope)
  instrumentation/                 # the capture core — see instrumentation/CLAUDE.md
    http-body-capture.ts           # EGRESS: PassThrough-tee capture of req/resp bodies on the http/https client path
    http-server-capture.ts         # INGRESS: incoming request + response body capture (direction="server")
    assemble-call.ts               # direction-agnostic redact-at-source assembler (both paths funnel through here)
    classify-host.ts               # external | internal edge heuristic (byte-identical in the collector)
    otlp-record.ts                 # build the flanj.* OTLP log record from a CapturedCall
    captured-call.ts, capped-buffer.ts, http-args.ts, config.ts
  mcp/                             # v0.5 Step B: MCP CLIENT instrumentation — see mcp/CLAUDE.md
    instrument-mcp-client.ts       # instrumentMcpClient(client): wrap listTools/callTool, pass-through, both package lines
    auto-instrument.ts             # constructor auto-patch path (optional peers, feature-detected, never required)
    assemble-mcp-call.ts           # tools/call -> CapturedCall via the shared assembler (same floor, same caps)
    assemble-contract-snapshot.ts  # complete tools/list -> floor-redacted ToolDef-shaped contract_snapshot
    mcp-record.ts, resolve-mcp-edge.ts, mcp-types.ts
packages/
  redaction-patterns/              # published Apache package: the redaction floor (see REDACTION.md)
    src/recognizer.ts              # the swappable interface: Recognizer.find(scalar, ctx) -> confirmed spans
    src/recognizers/*.ts           # PAN (Luhn via validator), EMAIL, IBAN, PHONE (libphonenumber-js), SSN, CVV, TOKEN, IP
    src/scalar.ts                  # per-scalar engine: token protection -> recognizers -> base64 decode-then-scan
    src/text-path.ts               # the production path for body strings: JSON scanner (span-splice) + form path
    src/redactor.ts                # createRedactor(): redact(value) structural + redactText(text)
    src/redact.ts, redact-headers.ts   # redact()/redactDetailed() + the header allowlist/token pass
    src/enhancer.ts                # schema-aware enhancer (ADD-only, never subtracts)
    src/props.ts                   # captured, non-reversible properties of whole-value redactions (redaction.fields)
    src/tokens.ts, report-order.ts, luhn.ts, base64.ts, numbers.ts, json-string.ts, chars.ts
    test/vectors.spec.ts           # conformance against contracts/redaction-vectors.json
    test/fixtures.spec.ts          # the CROSS-LANGUAGE parity battery (contracts/redaction-fixtures.json; Go runs it too)
    test/no-network.spec.ts        # zero-external-calls sentinel
    test/property.spec.ts, recognizers.spec.ts, redact-headers.spec.ts
test/integration/                  # real in-process http calls end-to-end (client, server, ignore-self-export,
                                   # otlp-endpoint 404-is-not-silent, register-flush spawning REAL children)
test/fixtures/                     # plain-CJS child scripts driven by test/integration/register-flush.spec.ts
test/packaging.spec.ts             # asserts the REAL `yarn pack` file list (dist entries in; src/test/contracts out)
test/readme.spec.ts                # asserts the README's first-run floor incl. the Not-captured list (fetch/undici)
scripts/smoke-pack.sh              # a stranger's first run: pack -> npm install the tarball -> require ./register
contracts/                         # vendored from the canonical e2e/contracts (do not hand-edit; sync) — see contracts/README.md
REDACTION.md                       # the floor's design: composed validators, owned responsibilities, parity, never-subtract
```

## Non-negotiables (do not regress)

1. **Redact before attach/export.** Assemble the capped raw buffer, redact, keep only the redacted string,
   **drop the raw buffer**. A raw body must never be set as an attribute — not even transiently.
2. **Capture correctly.** Use the PassThrough-tee custom instrumentation for response bodies (a passive
   `on('data')` listener breaks apps that read the body via `for await`). v0 targets the core `http`/`https`
   client path (egress) and server path (ingress); `fetch`/undici body capture is deferred.
3. **Caps & gating.** Content-type gate (JSON/text/form only); 16 KiB body cap (`body_cap_bytes`); header
   allowlist (never emit `authorization`/`cookie` raw).
4. **Emit the exact `flanj.*` convention** in `contracts/CONTRACTS.md` §2. The emitted record must match
   `contracts/golden-otlp-call.json`.

## Contract

Wire formats are pinned in `contracts/` (vendored; schema_version **1**). The redaction floor is governed by
`contracts/redaction-vectors.json` AND `contracts/redaction-fixtures.json` (the cross-language parity battery the
Go collector also runs) — **lead with those suites**; they are security-critical. Never change a wire format or a
redaction behaviour here; change it in the canonical contract first, re-vendor to sdk/collector/control-plane,
and keep all three suites green. The floor must never do I/O (ESLint bans every network/process/fs import in
`packages/redaction-patterns/src/**`; `test/no-network.spec.ts` is the runtime sentinel). Do not hand-roll regex
detection: locate candidates, let the composed validators decide (see `REDACTION.md`). When the package changes,
republish it so downstream consumers pick up the new version.

## Conventions

One export per file, kebab-case filenames, PascalCase classes, always type everything, avoid `any`. Tests
colocated `*.spec.ts`, Arrange-Act-Assert. `git commit -s` (DCO enforced — see CONTRIBUTING.md).

## Docs

`docs/CONCEPTS.md` (sanitized, public-safe engineering overview). Deeper local context lives in
`src/instrumentation/CLAUDE.md` and `packages/redaction-patterns/README.md`.

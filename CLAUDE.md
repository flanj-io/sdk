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

- TypeScript, Yarn 4. OTel-JS `@opentelemetry/api ^1.9`, SDK+instrumentation `^0.221`.
- **Node `^20.16.0 || >=22.3.0`** — the published `engines`, and a real floor, not a preference: the
  capture path patches core `http` through `process.getBuiltinModule`, which exists only from Node
  20.16.0 and 22.3.0 (so NOT 18.x, 20.6–20.15, any 21.x, or 22.0–22.2). `start()` refuses to run
  below it with one sentence. Three places state that range and a test locks each pair: `engines.node`,
  the README's Quick start line (`test/readme.spec.ts`), and `SUPPORTED_NODE_RANGE`
  (`src/instrumentation/builtin-module.spec.ts`). Change all three or none. Develop on 22+; CI runs the
  whole suite on every line the range claims: 20.16.0 and 22.3.0 (the floors), 22, 23 and 24.
- `yarn install` · `yarn build` · `yarn test` (unit + redaction vectors + OTLP contract + pack manifest +
  the release-artifact checks) ·
  `yarn test:watch` · `yarn lint` · `bash scripts/smoke-pack.sh` (packs, installs the tarball into a scratch app).
- `@opentelemetry/sdk-trace-base` / `-node` are devDeps of the coexistence fixtures, pinned **exactly** to the
  version `@opentelemetry/sdk-node` already resolves: a `^` range resolves a second, newer OTel core into the
  tree and the fixtures then run against a different core than the SDK does.
- **Publishing is a tag, not a laptop.** `.github/workflows/release.yml` is the only thing in this repo that
  publishes: push `vX.Y.Z` and it builds from an empty `dist/`, runs the gate, packs, verifies the tarballs
  against the tag, keeps them as an artifact, publishes and then installs the result from the registry. The
  floor `@flanj/redaction-patterns` goes **first** — `yarn pack` rewrites the SDK's `workspace:^` dependency
  into a plain range at PACK time, so the SDK tarball is uninstallable until the floor is on the registry.
  It publishes the Yarn-produced tarballs with `npm publish <tgz>`: Yarn 4 does not read `~/.npmrc`, and
  publishing the inspected artifact means the bytes that ship are the bytes that were checked. Auth is npm
  trusted publishing (OIDC) — no token. `CONTRIBUTING.md` has the procedure, what the `workflow_dispatch`
  dry run does and does not prove, and the one-time per-package setup only an owner can do.

## Layout

```
src/
  index.ts                         # the distro entrypoint (start(): register the three HTTP instrumentations + OTLP logs exporter)
  register.ts                      # the `./register` zero-code entry (see package.json exports) — KEEPS the handle,
                                   # and switches on BOTH capture paths: HTTP bodies (node:http + fetch) + MCP auto-instrumentation
  otlp-endpoint.ts                 # endpoint resolution: FLANJ_/OTEL_ precedence + base-URL -> /v1/logs normalization
  export-failure-warning.ts        # wraps the exporter so the FIRST export failure prints one line (no diag hijack)
  capture-warning.ts               # the FIRST failed capture prints one line (same text + env var as the Python SDK)
  flush-on-exit.ts                 # beforeExit + SIGTERM/SIGINT flush, bounded, then re-raise the signal
  version.ts                       # package version (OTLP scope)
  instrumentation/                 # the capture core — see instrumentation/CLAUDE.md
    http-body-capture.ts           # EGRESS: PassThrough-tee capture of req/resp bodies on the http/https client path
    http-server-capture.ts         # INGRESS: incoming request + response body capture (direction="server")
    fetch-body-capture.ts          # EGRESS for global fetch(): an interceptor composed onto undici's global dispatcher
    tee-request-body.ts, tee-dispatch-handler.ts   # the fetch tees: request body on its way out; response via
                                   # the handler callbacks (undici 6 AND 7 handler APIs, feature-detected)
    undici-global-dispatcher.ts, undici-headers.ts, undici-types.ts   # Node's BUNDLED undici, never a userland copy;
    compose-dispatcher.ts, to-legacy-handler.ts   # the global-dispatcher slots .1/.2 and the .2 bridge (see instrumentation/CLAUDE.md)
    assemble-call.ts               # direction-agnostic redact-at-source assembler (both paths funnel through here)
    classify-host.ts               # external | internal edge heuristic (byte-identical in the collector)
    trusted-proxies.ts             # the peers whose X-Forwarded-For ingress may believe (IPs/CIDRs; default none)
    resolve-ingress-peer.ts        # ingress caller: socket peer, or the hop a TRUSTED proxy appended (never the leftmost)
    otlp-record.ts                 # build the flanj.* OTLP log record from a CapturedCall
    wrap-layer.ts                  # patch by STACKING on the wrapper already there (coexist with OTel's http instr.)
    flanj-instrumentation.ts       # the base both capture classes extend — no OTel module hooks, no RITM singleton
    builtin-module.ts              # the LIVE core exports both paths patch (accessor snapshotted at load) + the
                                   # Node-version gate (start() throws below it)
    captured-call.ts, capped-buffer.ts, http-args.ts, config.ts
  mcp/                             # v0.5 Step B: MCP CLIENT instrumentation — see mcp/CLAUDE.md
    instrument-mcp-client.ts       # instrumentMcpClient(client): wrap listTools/callTool, pass-through, both package lines
    auto-instrument.ts             # constructor auto-patch path (optional peers, feature-detected, never required);
                                   # loads each peer BOTH ways — see non-negotiable 6
    resolve-import-url.mts         # the one ES module: sync `import.meta.resolve`, so the preload can find the ESM build
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
                                   # otlp-endpoint 404-is-not-silent, register-flush + otel-coexistence spawning
                                   # REAL children — the latter proves OTel's http spans survive both orders)
test/fixtures/                     # child scripts the integration specs spawn: plain-CJS (register-flush),
                                   # esm-named-import/, otel-coexistence/ (OTel HttpInstrumentation or
                                   # UndiciInstrumentation + Flanj), one-shot-fetch.js
test/packaging.spec.ts             # asserts the REAL `yarn pack` file list (dist entries in; src/test/contracts out;
                                   # no source maps — sources are not shipped, so a map could not resolve: sdk#33)
test/readme.spec.ts                # asserts the README's first-run floor incl. fetch() scope and its two uncaptured edges
test/verify-release.spec.ts        # every release check, seen RED on a tarball built to break exactly that one
scripts/smoke-pack.sh              # a stranger's first run: pack -> npm install the tarball -> require ./register
                                   # -> one node:http call AND one fetch() call, two records
scripts/verify-release.cjs         # the pre-publish gate: tag vs both package.jsons, the rewritten floor range,
                                   # what each tarball must and must not contain — read from the TARBALL, not the tree
contracts/                         # vendored from the canonical contract (do not hand-edit; re-vendor) — see contracts/README.md
REDACTION.md                       # the floor's design: composed validators, owned responsibilities, parity, never-subtract
```

## Non-negotiables (do not regress)

1. **Redact before attach/export.** Assemble the capped raw buffer, redact, keep only the redacted string,
   **drop the raw buffer**. A raw body must never be set as an attribute — not even transiently.
2. **Capture correctly.** Use the PassThrough-tee custom instrumentation for response bodies (a passive
   `on('data')` listener breaks apps that read the body via `for await`). The core `http`/`https` client
   path (egress) and server path (ingress), plus global `fetch()` (egress): an interceptor composed onto
   undici's global dispatcher that tees the request body's async iterable and copies the response from the
   handler callbacks — it never answers, delays or rewrites a call, and never replaces `globalThis.fetch`.
3. **Caps & gating.** Content-type gate (JSON/text/form only); 16 KiB body cap (`body_cap_bytes`); header
   allowlist (never emit `authorization`/`cookie` raw). Bodies are stored DECODED — any `content-encoding`
   is undone before redaction, and a coding we cannot undo stores no body rather than an unscanned frame.
4. **Emit the exact `flanj.*` convention** in `contracts/CONTRACTS.md` §2. The emitted record must match
   `contracts/golden-otlp-call.json`.
5. **The zero-code entry covers BOTH capture paths, and says which.** `register.ts` starts HTTP body
   capture and auto-instruments MCP; its one startup line names `fetch()` only when the fetch layer was
   actually installed, and MCP only when a client package was actually patched. The Python SDK's
   `import flanj.register` is the same entry minus the HTTP half, and `contracts/CONTRACTS.md` §2 (*SDK parity*) records that as the ONLY intended difference between the two
   SDKs. Do not let the two entries diverge again without changing that note first.
6. **Patch an optional peer's BOTH halves, synchronously, in the preload.** Both
   `@modelcontextprotocol` packages are **dual**: `require` and `import` yield two different `Client`
   class objects, and patching one leaves the other untouched — silently. `auto-instrument.ts` patches
   the `require` half with `require`, and the `import` half with `require(esm)` on the file the `import`
   condition names (`resolve-import-url.mts` resolves it). Both must happen before the preload returns:
   a CommonJS app can call a tool in its own module body, and on Node 24 an ESM entry point starts
   before anything the preload left pending has settled — a late `import()` lost that race on every
   run there, and a few runs in ten on 22.12 and 23. Only where the runtime cannot load ESM
   synchronously (20.16–20.18, 22.3–22.11) does a real `import()` finish the job; `tsc` rewrites a
   literal `import()` into `require()`, so the `new Function` indirection is deliberate. An installed
   half that still is not patched goes to the one-time capture warning, never to silence. All of
   this is locked by `test/integration/register-mcp.spec.ts`, which CI runs on every supported line.
7. **Coexist with the app's OpenTelemetry.** Patching `node:http` must STACK on whatever is already
   installed (`instrumentation/wrap-layer.ts`) — never `isWrapped → _unwrap → wrap`, and never construct an
   OTel `InstrumentationBase`, whose require-in-the-middle singleton caches core modules and silences
   `@opentelemetry/instrumentation-http`. Both failure modes were silent; both are locked by
   `test/integration/otel-coexistence.spec.ts`. The `fetch()` layer follows the same rule: it COMPOSES onto
   whatever global dispatcher is installed and, on `disable()`, removes itself only while it is still the
   outermost layer (buried, it goes inert). `@opentelemetry/instrumentation-undici` hooks undici's
   diagnostics channels, not the dispatcher, and `test/integration/otel-undici-coexistence.spec.ts` holds
   both registration orders.

## Contract

Wire formats are pinned in `contracts/` (vendored; schema_version **1**). The redaction floor is governed by
`contracts/redaction-vectors.json` AND `contracts/redaction-fixtures.json` (the cross-language parity battery the
Go collector also runs) — **lead with those suites**; they are security-critical. Never change a wire format or a
redaction behaviour here; change it in the canonical contract first, re-vendor to the SDK, collector and control plane,
and keep all three suites green. The floor must never do I/O (ESLint bans every network/process/fs import in
`packages/redaction-patterns/src/**`; `test/no-network.spec.ts` is the runtime sentinel). Do not hand-roll regex
detection: locate candidates, let the composed validators decide (see `REDACTION.md`). When the package changes,
republish it so downstream consumers pick up the new version.

## Conventions

One export per file, kebab-case filenames, PascalCase classes, always type everything, avoid `any`. Tests
colocated `*.spec.ts`, Arrange-Act-Assert. `git commit -s` (DCO enforced — see CONTRIBUTING.md).

## Docs

`docs/CONCEPTS.md` (engineering overview). Deeper local context lives in
`src/instrumentation/CLAUDE.md` and `packages/redaction-patterns/README.md`.

## This repo is public — write for a stranger

Everything here, and everything written about it on GitHub (PR titles and descriptions, issues, comments),
is read by people outside the project. Do not point them at things they cannot open: no non-public
repositories or their PRs, no non-public design, planning or strategy documents, no labels for decisions
taken elsewhere, and no attribution of a decision to a person. Say the rule and the reason in place, in the
comment or doc that needs it. Cite only what a stranger can open: files in this repo, `contracts/CONTRACTS.md`,
and other public repos and their PRs. A vendored file's header says "Vendored — do not edit here" and
nothing more. A PR description stands alone: it links only to public repos.

# CLAUDE.md — `@vinifera/sdk`

Guidance for Claude Code (and engineers) working in this repo.

## What this repo is

The **Vinifera SDK**: a thin OpenTelemetry-JS distribution that adds HTTP **request/response body capture**
and **redaction-at-source**, then exports one OTLP log record per call to the collector. It is the first
step of the gate-2 loop (**capture** → detect → surface → flag → peek). Public, **Apache-2.0** — keep it
pristine (fintech legal inspects it; no copyleft/source-available deps, prefer Apache/MIT/BSD/ISC).

It also publishes **`@vinifera/redaction-patterns`** (Apache), the shared redaction floor the control plane
reuses for reply-box DLP.

## Role in the system

`app → (vinifera SDK captures + redacts) → OTLP/HTTP :4318 → collector`. OTel auto-instrumentation gives
spans/metadata but **not** bodies; bodies are the non-redundant evidence that make drift detection possible.
Redaction happens here, at the call site, **before** anything is attached or exported.

## Stack & commands

- TypeScript, Node 23, Yarn 4. OTel-JS `@opentelemetry/api ^1.9`, SDK+instrumentation `^0.221`.
- `yarn install` · `yarn build` · `yarn test` (unit + redaction vectors + OTLP contract) · `yarn test:watch` · `yarn lint`.

## Layout (target)

```
src/
  index.ts                         # the distro entrypoint (start(): register instrumentation + OTLP logs exporter)
  instrumentation/
    http-body-capture.ts           # PassThrough-tee capture of req/resp bodies on the http/https client path
    otlp-record.ts                 # build the vinifera.* OTLP log record from a captured call
  redaction/                       # thin re-export of @vinifera/redaction-patterns applied at source
packages/
  redaction-patterns/              # published Apache package: the redaction floor (PAN/Luhn, PII, tokens)
    src/index.ts
    test/vectors.spec.ts           # conformance against contracts/redaction-vectors.json
contracts/                         # vendored from the canonical e2e/contracts (do not hand-edit; sync)
```

## Non-negotiables (do not regress)

1. **Redact before attach/export.** Assemble the capped raw buffer, redact, keep only the redacted string,
   **drop the raw buffer**. A raw body must never be set as an attribute — not even transiently.
2. **Capture correctly.** Use the PassThrough-tee custom instrumentation for response bodies (a passive
   `on('data')` listener breaks apps that read the body via `for await`). v0 targets the `http`/`https`
   client path; `fetch`/undici body capture is deferred.
3. **Caps & gating.** Content-type gate (JSON/text/form only); 16 KiB body cap (`body_cap_bytes`); header
   allowlist (never emit `authorization`/`cookie` raw).
4. **Emit the exact `vinifera.*` convention** in `contracts/CONTRACTS.md` §2. The emitted record must match
   `contracts/golden-otlp-call.json`.

## Contract

Wire formats are pinned in `contracts/` (vendored; schema_version **1**). The redaction floor is governed by
`contracts/redaction-vectors.json` — **lead with that test suite**; it is security-critical. Never change a
wire format here; change it in the canonical contract first.

## Conventions

One export per file, kebab-case filenames, PascalCase classes, always type everything, avoid `any`. Tests
colocated `*.spec.ts`, Arrange-Act-Assert. `git commit -s` (DCO enforced — see CONTRIBUTING.md).

## Docs

`docs/CONCEPTS.md` (sanitized, public-safe engineering overview). Deeper local context lives in
`src/instrumentation/CLAUDE.md` and `packages/redaction-patterns/README.md`.

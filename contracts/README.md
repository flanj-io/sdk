# `contracts/` — vendored cross-repo contract (do not hand-edit)

Everything in this directory is a **byte-identical copy** of the canonical contract that lives in the
private `e2e` repo at `e2e/contracts/` (`CONTRACTS.md` + `v1/*`). It is the agreed language between the
SDK and the Flanj collector / control-plane — the OTLP wire convention the SDK emits and the
redaction floor it must enforce — not test data owned by another repo.

The SDK's test suite asserts against these files so `yarn test` proves, standalone, that what this SDK
emits is exactly what the collector expects and that redaction-at-source matches the Go implementation
bit-for-bit. None of this ships in the published npm package; it is a repo/CI artifact only.

## What is vendored here

| File | Role | Asserted by |
|---|---|---|
| `CONTRACTS.md` | the human-readable contract — the **public half** shared by SDK and collector (§2 OTLP convention and §6 redaction floor are the SDK-relevant sections; §5 lists only the CP endpoints the collector calls). The control plane's own contract is private and is not vendored here. | — |
| `golden-otlp-call.json` | the exact OTLP log record the SDK must emit for one drifting call (SDK → collector wire format) | `src/instrumentation/otlp-record.spec.ts`, `test/integration/http-capture.spec.ts` |
| `golden-otlp-mcp-call.json` | v0.5 (Step B): the exact OTLP log record the SDK must emit for one MCP `tools/call` (tool in the method/route slots, no status_code, `flanj.mcp.*` attrs, client-generated correlation id) | `src/mcp/mcp-record.spec.ts` |
| `golden-otlp-mcp-snapshot.json` | v0.5 (Step B): the exact `contract_snapshot` record for one complete observed `tools/list` (floor-redacted ToolDef-shaped JSON the collector's Step C loader decodes) | `src/mcp/mcp-record.spec.ts` |
| `redaction-vectors.json` | scalar/recognizer-level redaction floor vectors | `packages/redaction-patterns/test/vectors.spec.ts` |
| `redaction-fixtures.json` | the structured cross-language PARITY battery (the Go collector and control-plane DLP run the same file) | `packages/redaction-patterns/test/fixtures.spec.ts`, `…/no-network.spec.ts` |

## Layout note

The canonical tree is `contracts/CONTRACTS.md` + `contracts/v1/<fixtures>`; vendored copies are kept
**flat** (same as `collector/contracts/` and `control-plane/contracts/`). So the `./v1/…` links inside
`CONTRACTS.md` resolve to *this* directory, and its `./README.md` link refers to the canonical governance
doc in `e2e/contracts/README.md`, not this file.

## Changing anything

Edit the canonical file in `e2e/contracts/`, bump `schema_version` if the change is breaking, re-vendor
byte-identically to `sdk/`, `collector/`, `control-plane/`, and make every repo's suite green. See
`e2e/contracts/README.md` (governance) and `REDACTION.md` (redaction design) for the full rules.

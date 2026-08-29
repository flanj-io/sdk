# CLAUDE.md — `src/mcp/`

v0.5 **Step B**: instrument the MCP **Client** — turn a consumer agent's `tools/list` / `tools/call`
into the same capture → detect loop a REST integration rides. Transport-independent by design
(spec §3): we wrap the Client object, never a transport (no proxying, no stdio process spawning,
no HTTP sniffing) — and the wrapper is strictly **out-of-band**: it never changes a call, a result,
or an error. Capture failure = "we stopped collecting", never "the agent broke".

## Files (one concern each)

| File | Role |
|---|---|
| `instrument-mcp-client.ts` | `instrumentMcpClient(client, options)` — patch `listTools`/`callTool` on the instance, byte-identical pass-through (result identity preserved, rejections rethrown untouched). `listTools` pages accumulate across the caller's cursor chain and emit **one `contract_snapshot` per complete list** — pages are KEYED to the in-flight chain's expected next cursor: a head page starts (or supersedes) the chain, and a page whose cursor does not match the chain is discarded, so a superseded or interleaved chain simply produces no snapshot, never a partial/mixed one; a `notifications/tools/list_changed` (via the CHAINED fallback notification handler — the app's own handler still runs) triggers a bounded refetch + re-snapshot. `callTool` emits one redacted call record. The JSON-RPC id is observed on the client's own outgoing `transport.send` messages (observation only; the send-observer is keyed per (transport, client) in a per-transport registry, so clients sharing one transport each observe only their own requests and dropping one never breaks the other; FIFO-claimed per tool, best-effort under concurrency) — **client-generated, labeled as such**, never presented as a provider id. |
| `auto-instrument.ts` | The auto-patch path: `patchMcpClientConstructor` (prototype trampolines that self-instrument each instance on first use) + `registerMcpAutoInstrumentation` (feature-detects `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/client` 2.x — both OPTIONAL peers, a missing package is silently skipped; there is no import of either package anywhere in `src/`). |
| `assemble-mcp-call.ts` | `assembleMcpCall` — funnels through the ONE shared `assembleCapturedCall`, so every floor rule (cap, content-type gate, internal-edge metadata-only, redact-then-drop, captured-value props) applies identically. Slots: method `"tools/call"`, route/target `"/<tool>"`, url `"mcp://<peer>/<tool>"`, statusCode 0 (MCP has none). Request body = arguments; response body = `structuredContent` (JSON) else joined `content[]` text (`text/plain` — the floor's text path parses-then-traverses JSON text, so a PAN inside stringified JSON is caught structurally; the shared fixture battery pins the four §4.B cases). |
| `assemble-contract-snapshot.ts` | `assembleContractSnapshot` — projects each tool onto the ToolDef wire keys (`name/description/inputSchema/outputSchema/annotations` — collector `contract.ParseToolsList` decodes this in Step C), adds `serverInfo`/`protocolVersion`/`capabilities.tools.listChanged`, then floor-redacts the whole JSON before anything is attached. Schemas verbatim; no `outputSchema` stays absent (the honest "no output contract declared" state). |
| `resolve-mcp-edge.ts` | Edge identity (spec §4.B): streamable-HTTP → endpoint URL host[:port] through the shared external/internal heuristic; stdio → `serverInfo.name`, class **`local-process`** (additive `flanj.edge.class` value, CONTRACTS §2). `local-process` captures + redacts bodies (a local MCP process usually fronts an external API); an `internal` HTTP peer stays metadata-only. |
| `mcp-record.ts` | `McpCapturedCall`/`McpContractSnapshot` → the CONTRACTS §2 "v0.5 (Step B)" rows. Call records: the HTTP attribute set plus `flanj.transport`/`flanj.mcp.*`, minus `flanj.http.status_code`; `flanj.corr.client_request_id` carries the client-generated id and `flanj.corr.request_id` stays provider-issued-only (the wrapper sees no HTTP response headers, so it emits none). |
| `mcp-types.ts` | The shared shapes. `McpCapturedCall extends CapturedCall` — same RedactedCall shape as HTTP. |

## Never break

- **Pass-through is the contract** (spec §3/§6): result object IDENTITY preserved, arguments never
  cloned or mutated, errors rethrown unchanged, a throwing capture sink swallowed. Locked by
  `instrument-mcp-client.spec.ts` for BOTH package lines (mock Clients — the packages are never
  imported).
- **Redact before attach/emit** — same day-one rule as HTTP. The four spec §4.B redaction cases live
  in the SHARED cross-language battery (`contracts/redaction-fixtures.json`, `mcp-*` ids) AND as
  assembler-level sentinels in `assemble-mcp-call.spec.ts`.
- **Golden lock:** `mcp-record.spec.ts` locks raw-input → attributes against
  `contracts/golden-otlp-mcp-call.json` / `golden-otlp-mcp-snapshot.json` (exact key set + scalars),
  the same convention as `otlp-record.spec.ts`.
- **One snapshot per COMPLETE list.** A failed page ends the chain and emits nothing partial.
- **Honest labels.** Client-generated ids are never surfaced in a provider-issued slot; server
  identity attributes are omitted (never guessed) when the client does not surface them.

## Wiring

`instrumentMcpClient(client, { integration, endpoint?, logger?, onCapture?, onSnapshot? })` — pass an
OTLP logger (e.g. `handle.loggerProvider.getLogger('@flanj/sdk', SDK_VERSION)` from `start()`) or
sinks. `registerMcpAutoInstrumentation(options)` patches whichever MCP client package is installed.

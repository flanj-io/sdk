import type { PatternId } from '@flanj/redaction-patterns';
import type { CapturedCall } from '../instrumentation/captured-call';

/**
 * How the MCP server is reached, as far as the CLIENT can tell (v0.5 spec §4.B).
 * The SDK instruments the Client, never a transport — this is derived from the
 * client's own transport reference / config, not from sniffing.
 */
export type McpServerKind = 'streamable-http' | 'stdio';

/**
 * Server identity (all optional — feature-detected).
 *
 * Protocol revision 2026-07-28 removed the `initialize` handshake, so the
 * client-side accessors that used to carry this (`getServerVersion()`,
 * `client.serverInfo`, `client.protocolVersion`) are empty against a current
 * server. The authoritative source is now the `_meta` of every result
 * (`io.modelcontextprotocol/serverInfo`); the handshake accessors survive only
 * as a fallback for servers still on an older revision.
 */
export interface McpServerIdentity {
  name?: string;
  version?: string;
  protocolVersion?: string;
  /** `capabilities.tools.listChanged` when the client exposes capabilities. */
  listChanged?: boolean;
}

/** MCP-specific metadata attached to a captured tool call. */
export interface McpCallMeta {
  toolName: string;
  /** The MCP result's `isError` flag (also true when the call rejected). */
  isError: boolean;
  serverKind: McpServerKind;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  /**
   * `Mcp-Session-Id` when the transport exposes one.
   *
   * Protocol-level sessions were removed in revision 2026-07-28 along with the
   * handshake, so this is permanently absent against a current server. The slot
   * is kept — every reader treats it as optional — so a client still on the
   * 2025-11-25 line keeps reporting what it has.
   */
  sessionId?: string;
  /**
   * The result's `resultType` (revision 2026-07-28), verbatim: `complete`,
   * `input_required`, or whatever a future revision adds. Absent on older
   * servers, which must NOT be read as `complete`.
   *
   * `input_required` is normal traffic on an interactive tool — the payload is
   * partial by design — so detection must skip it rather than judge it.
   */
  resultType?: string;
  /**
   * Set when the result was a Tasks HANDLE rather than a payload: the call
   * returned `{task: {taskId, …}}` and the real result arrives later via
   * `tasks/get`. Such a record describes the envelope, never the tool's output,
   * so nothing may validate or model response shape from it.
   */
  taskId?: string;
  /**
   * The JSON-RPC request id observed on the client's own outgoing message —
   * CLIENT-GENERATED. It appears in the provider's logs only if they log it;
   * it is never presented as a provider-issued id (CONTRACTS §2,
   * `flanj.corr.client_request_id`).
   */
  clientRequestId?: string;
}

/**
 * One captured MCP tool call on the SAME RedactedCall shape as HTTP: the tool
 * name rides the method/route slots (`tools/call` + `/<tool>`), arguments are
 * the request body, `structuredContent` (else `content[]` text) is the response
 * body — all floor-redacted at source. `statusCode` is always 0 (MCP has no
 * status codes; `mcp.isError` carries the outcome).
 */
export interface McpCapturedCall extends CapturedCall {
  transport: 'mcp';
  mcp: McpCallMeta;
}

/**
 * One complete observed `tools/list` — the self-delivering contract snapshot
 * (v0.5 spec §4.C). `snapshotJson` is the floor-REDACTED canonical JSON the
 * collector's Step C loader decodes:
 * `{"tools":[ToolDef…],"serverInfo"?,"protocolVersion"?,"capabilities"?}` with
 * ToolDef wire keys `name/description/inputSchema/outputSchema/annotations`
 * (collector `contract.ToolDef` / `ParseToolsList`).
 */
export interface McpContractSnapshot {
  integration: string;
  peerHost: string;
  edgeClass: 'external' | 'internal' | 'local-process';
  serverKind: McpServerKind;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  /** Floor-redacted canonical snapshot JSON (see above). */
  snapshotJson: string;
  /**
   * `ttlMs` / `cacheScope` from the `tools/list` result (revision 2026-07-28),
   * when the server published them. Clients are now told to CACHE catalogs, so
   * the list a snapshot records may legitimately be up to `ttlMs` behind the
   * server — a reader that presents a snapshot as live would be overstating it.
   * Also carried inside `snapshotJson` so the stored document is self-describing.
   */
  catalogTtlMs?: number;
  catalogCacheScope?: string;
  toolCount: number;
  redactionApplied: boolean;
  redactionPatterns: PatternId[];
}

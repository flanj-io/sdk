import type { PatternId } from '@vinifera/redaction-patterns';
import type { CapturedCall } from '../instrumentation/captured-call';

/**
 * How the MCP server is reached, as far as the CLIENT can tell (v0.5 spec §4.B).
 * The SDK instruments the Client, never a transport — this is derived from the
 * client's own transport reference / config, not from sniffing.
 */
export type McpServerKind = 'streamable-http' | 'stdio';

/** Server identity as surfaced by the client after `initialize` (all optional — feature-detected). */
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
  /** `Mcp-Session-Id` when the transport exposes one (2025-11-25 line; absent on stateless). */
  sessionId?: string;
  /**
   * The JSON-RPC request id observed on the client's own outgoing message —
   * CLIENT-GENERATED. It appears in the provider's logs only if they log it;
   * it is never presented as a provider-issued id (CONTRACTS §2,
   * `vinifera.corr.client_request_id`).
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
  toolCount: number;
  redactionApplied: boolean;
  redactionPatterns: PatternId[];
}

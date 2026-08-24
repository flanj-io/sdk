import { SeverityNumber, type LogAttributes, type Logger } from '@opentelemetry/api-logs';
import { CAPTURE_VERSION } from '../version';
import { buildLogAttributes } from '../instrumentation/otlp-record';
import type { McpCapturedCall, McpContractSnapshot } from './mcp-types';

/**
 * Map a redacted {@link McpCapturedCall} to the `vinifera.*` convention
 * (CONTRACTS §2, "MCP tool call record — v0.5 Step B"): the HTTP call mapping
 * plus the additive `vinifera.transport` / `vinifera.mcp.*` attributes, minus
 * `vinifera.http.status_code` (MCP has none — `vinifera.mcp.is_error` carries
 * the outcome). The JSON-RPC id rides `vinifera.corr.client_request_id`, a slot
 * whose name says what it is: CLIENT-generated, never a provider-issued id.
 */
export function buildMcpCallAttributes(call: McpCapturedCall): LogAttributes {
  const attrs = buildLogAttributes(call);
  delete attrs['vinifera.http.status_code'];

  attrs['vinifera.transport'] = 'mcp';
  attrs['vinifera.mcp.tool.name'] = call.mcp.toolName;
  attrs['vinifera.mcp.is_error'] = call.mcp.isError;
  if (call.mcp.serverName !== undefined) attrs['vinifera.mcp.server.name'] = call.mcp.serverName;
  if (call.mcp.serverVersion !== undefined) attrs['vinifera.mcp.server.version'] = call.mcp.serverVersion;
  if (call.mcp.protocolVersion !== undefined) attrs['vinifera.mcp.protocol.version'] = call.mcp.protocolVersion;
  if (call.mcp.sessionId !== undefined) attrs['vinifera.mcp.session.id'] = call.mcp.sessionId;
  if (call.mcp.clientRequestId !== undefined) {
    attrs['vinifera.corr.client_request_id'] = call.mcp.clientRequestId;
  }
  return attrs;
}

/**
 * Map a {@link McpContractSnapshot} to the `vinifera.*` convention
 * (CONTRACTS §2, "contract_snapshot record — v0.5 Step B"). One record per
 * COMPLETE observed `tools/list`; the observation timestamp is the log
 * record's own timestamp.
 */
export function buildContractSnapshotAttributes(snap: McpContractSnapshot): LogAttributes {
  const attrs: LogAttributes = {
    'vinifera.capture.version': CAPTURE_VERSION,
    'vinifera.record.type': 'contract_snapshot',
    'vinifera.transport': 'mcp',
    'vinifera.direction': 'client',
    'vinifera.peer.host': snap.peerHost,
    'vinifera.edge.class': snap.edgeClass,
    'vinifera.integration': snap.integration,
    'vinifera.mcp.contract_snapshot': snap.snapshotJson,
    'vinifera.mcp.tool.count': snap.toolCount,
    'vinifera.redaction.applied': snap.redactionApplied,
    'vinifera.redaction.patterns': JSON.stringify(snap.redactionPatterns)
  };
  if (snap.serverName !== undefined) attrs['vinifera.mcp.server.name'] = snap.serverName;
  if (snap.serverVersion !== undefined) attrs['vinifera.mcp.server.version'] = snap.serverVersion;
  if (snap.protocolVersion !== undefined) attrs['vinifera.mcp.protocol.version'] = snap.protocolVersion;
  return attrs;
}

/** Emit one OTLP log record for a completed MCP tool call (body empty; data in attributes). */
export function emitMcpCall(logger: Logger, call: McpCapturedCall): void {
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: '',
    attributes: buildMcpCallAttributes(call)
  });
}

/** Emit one OTLP log record for a complete observed `tools/list`. */
export function emitContractSnapshot(logger: Logger, snap: McpContractSnapshot): void {
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: '',
    attributes: buildContractSnapshotAttributes(snap)
  });
}

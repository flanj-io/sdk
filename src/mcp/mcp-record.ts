import { SeverityNumber, type LogAttributes, type Logger } from '@opentelemetry/api-logs';
import { CAPTURE_VERSION } from '../version';
import { buildLogAttributes } from '../instrumentation/otlp-record';
import type { McpCapturedCall, McpContractSnapshot } from './mcp-types';

/**
 * Map a redacted {@link McpCapturedCall} to the `flanj.*` convention
 * (CONTRACTS §2, "MCP tool call record — v0.5 Step B"): the HTTP call mapping
 * plus the additive `flanj.transport` / `flanj.mcp.*` attributes, minus
 * `flanj.http.status_code` (MCP has none — `flanj.mcp.is_error` carries
 * the outcome). The JSON-RPC id rides `flanj.corr.client_request_id`, a slot
 * whose name says what it is: CLIENT-generated, never a provider-issued id.
 */
export function buildMcpCallAttributes(call: McpCapturedCall): LogAttributes {
  const attrs = buildLogAttributes(call);
  delete attrs['flanj.http.status_code'];

  attrs['flanj.transport'] = 'mcp';
  attrs['flanj.mcp.tool.name'] = call.mcp.toolName;
  attrs['flanj.mcp.is_error'] = call.mcp.isError;
  if (call.mcp.serverName !== undefined) attrs['flanj.mcp.server.name'] = call.mcp.serverName;
  if (call.mcp.serverVersion !== undefined) attrs['flanj.mcp.server.version'] = call.mcp.serverVersion;
  if (call.mcp.protocolVersion !== undefined) attrs['flanj.mcp.protocol.version'] = call.mcp.protocolVersion;
  if (call.mcp.sessionId !== undefined) attrs['flanj.mcp.session.id'] = call.mcp.sessionId;
  if (call.mcp.clientRequestId !== undefined) {
    attrs['flanj.corr.client_request_id'] = call.mcp.clientRequestId;
  }
  return attrs;
}

/**
 * Map a {@link McpContractSnapshot} to the `flanj.*` convention
 * (CONTRACTS §2, "contract_snapshot record — v0.5 Step B"). One record per
 * COMPLETE observed `tools/list`; the observation timestamp is the log
 * record's own timestamp.
 */
export function buildContractSnapshotAttributes(snap: McpContractSnapshot): LogAttributes {
  const attrs: LogAttributes = {
    'flanj.capture.version': CAPTURE_VERSION,
    'flanj.record.type': 'contract_snapshot',
    'flanj.transport': 'mcp',
    'flanj.direction': 'client',
    'flanj.peer.host': snap.peerHost,
    'flanj.edge.class': snap.edgeClass,
    'flanj.integration': snap.integration,
    'flanj.mcp.contract_snapshot': snap.snapshotJson,
    'flanj.mcp.tool.count': snap.toolCount,
    'flanj.redaction.applied': snap.redactionApplied,
    'flanj.redaction.patterns': JSON.stringify(snap.redactionPatterns)
  };
  if (snap.serverName !== undefined) attrs['flanj.mcp.server.name'] = snap.serverName;
  if (snap.serverVersion !== undefined) attrs['flanj.mcp.server.version'] = snap.serverVersion;
  if (snap.protocolVersion !== undefined) attrs['flanj.mcp.protocol.version'] = snap.protocolVersion;
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

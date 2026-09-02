import { redactDetailed } from '@flanj/redaction-patterns';
import type { CatalogCacheHints } from './result-meta';
import type { McpContractSnapshot, McpServerIdentity, McpServerKind } from './mcp-types';

/** Inputs for one COMPLETE observed `tools/list` (all pages). */
export interface AssembleContractSnapshotInput {
  integration: string;
  peerHost: string;
  edgeClass: 'external' | 'internal' | 'local-process';
  serverKind: McpServerKind;
  server: McpServerIdentity;
  /** The complete tools array, verbatim from the server. */
  tools: readonly unknown[];
  /**
   * `ttlMs` / `cacheScope` off the `tools/list` result (revision 2026-07-28),
   * when the server published them.
   */
  cache?: CatalogCacheHints;
}

/**
 * Assemble the `contract_snapshot` payload: the full tools array projected onto
 * the ToolDef wire keys the collector's Step C loader decodes
 * (`name/description/inputSchema/outputSchema/annotations` — collector
 * `contract.ToolDef`), plus server identity — then floor-redacted as one JSON
 * text before anything is attached or emitted. Schemas are the server's own
 * words: passed through verbatim, never re-inferred; a tool without
 * `outputSchema` keeps none (the honest "no output contract declared" state).
 */
export function assembleContractSnapshot(input: AssembleContractSnapshotInput): McpContractSnapshot {
  const tools = input.tools.map(toToolDef).filter((t): t is Record<string, unknown> => t !== undefined);

  const payload: Record<string, unknown> = { tools };
  if (input.server.name !== undefined || input.server.version !== undefined) {
    const serverInfo: Record<string, unknown> = {};
    if (input.server.name !== undefined) serverInfo.name = input.server.name;
    if (input.server.version !== undefined) serverInfo.version = input.server.version;
    payload.serverInfo = serverInfo;
  }
  if (input.server.protocolVersion !== undefined) payload.protocolVersion = input.server.protocolVersion;
  if (input.server.listChanged !== undefined) {
    payload.capabilities = { tools: { listChanged: input.server.listChanged } };
  }
  // Cache directives ride INSIDE the document as well as on the record, so the
  // stored snapshot stays self-describing: a reader holding only the doc can
  // still tell how stale the catalog it is checking against may be.
  if (input.cache?.ttlMs !== undefined) payload.ttlMs = input.cache.ttlMs;
  if (input.cache?.cacheScope !== undefined) payload.cacheScope = input.cache.cacheScope;

  // Redact-at-source: the snapshot crosses the wire only as this redacted text.
  const redaction = redactDetailed(JSON.stringify(payload));

  const snap: McpContractSnapshot = {
    integration: input.integration,
    peerHost: input.peerHost,
    edgeClass: input.edgeClass,
    serverKind: input.serverKind,
    snapshotJson: redaction.text,
    toolCount: tools.length,
    redactionApplied: redaction.patterns.length > 0,
    redactionPatterns: redaction.patterns
  };
  if (input.server.name !== undefined) snap.serverName = input.server.name;
  if (input.server.version !== undefined) snap.serverVersion = input.server.version;
  if (input.server.protocolVersion !== undefined) snap.protocolVersion = input.server.protocolVersion;
  if (input.cache?.ttlMs !== undefined) snap.catalogTtlMs = input.cache.ttlMs;
  if (input.cache?.cacheScope !== undefined) snap.catalogCacheScope = input.cache.cacheScope;
  return snap;
}

/** Project one tool onto the ToolDef wire keys; entries without a name are dropped. */
function toToolDef(tool: unknown): Record<string, unknown> | undefined {
  if (tool === null || typeof tool !== 'object') return undefined;
  const t = tool as Record<string, unknown>;
  if (typeof t.name !== 'string' || t.name.length === 0) return undefined;
  const def: Record<string, unknown> = { name: t.name };
  if (typeof t.description === 'string') def.description = t.description;
  if (t.inputSchema !== undefined) def.inputSchema = t.inputSchema;
  if (t.outputSchema !== undefined) def.outputSchema = t.outputSchema;
  if (t.annotations !== undefined) def.annotations = t.annotations;
  return def;
}

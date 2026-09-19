import { classifyHost } from '../instrumentation/classify-host';
import type { McpServerKind } from './mcp-types';

/** Inputs for MCP edge identity (v0.5 spec §4.B "Edge classification"). */
export interface ResolveMcpEdgeInput {
  /** Explicit streamable-HTTP endpoint (config wins over detection). */
  endpoint?: string;
  /** Explicit server kind (config wins over detection). */
  serverKind?: McpServerKind;
  /** The client's transport reference, inspected read-only (never patched here). */
  transport?: unknown;
  /** `serverInfo.name` — the stdio edge key. */
  serverName?: string;
}

export interface McpEdge {
  /** The edge key: streamable-HTTP → endpoint URL host[:port]; stdio → serverInfo.name. */
  peerHost: string;
  /**
   * streamable-HTTP peers go through the existing external/internal heuristic;
   * stdio servers are the v0.5 class `local-process` (a local MCP process is
   * usually a thin wrapper over an external API — captured, never surfaced as
   * an internal HTTP edge).
   */
  edgeClass: 'external' | 'internal' | 'local-process';
  serverKind: McpServerKind;
}

/** Fallback edge key when a stdio server has not surfaced a serverInfo.name yet. */
export const UNKNOWN_MCP_SERVER = 'unknown-mcp-server';

/**
 * Resolve the MCP edge identity from what the CLIENT exposes: an explicit
 * endpoint/kind from config, else the transport's own `url` property
 * (streamable HTTP), else stdio. Read-only feature detection — never throws.
 */
export function resolveMcpEdge(input: ResolveMcpEdgeInput): McpEdge {
  const url = input.endpoint ?? transportUrl(input.transport);
  const kind: McpServerKind = input.serverKind ?? (url !== undefined ? 'streamable-http' : 'stdio');

  if (kind === 'streamable-http' && url !== undefined) {
    const host = safeHost(url);
    if (host !== undefined) {
      return { peerHost: host, edgeClass: classifyHost(host), serverKind: 'streamable-http' };
    }
  }
  if (kind === 'streamable-http') {
    // Declared HTTP but no resolvable URL: fall back to the server name, still HTTP-classified.
    const host = input.serverName ?? UNKNOWN_MCP_SERVER;
    return { peerHost: host, edgeClass: classifyHost(host), serverKind: 'streamable-http' };
  }
  return { peerHost: input.serverName ?? UNKNOWN_MCP_SERVER, edgeClass: 'local-process', serverKind: 'stdio' };
}

/** A transport's endpoint URL when it exposes one (`url` on the streamable-HTTP transports). */
function transportUrl(transport: unknown): string | undefined {
  if (transport === null || typeof transport !== 'object') return undefined;
  const t = transport as Record<string, unknown>;
  for (const key of ['url', '_url']) {
    try {
      const v = t[key];
      if (typeof v === 'string' && v.length > 0) return v;
      if (v instanceof URL) return v.toString();
    } catch {
      /* hostile getter — read-only feature detection never throws */
    }
  }
  return undefined;
}

function safeHost(url: string): string | undefined {
  try {
    const host = new URL(url).host;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The endpoint URLs of the instrumented MCP clients in this process.
 *
 * The streamable-HTTP MCP transport speaks JSON-RPC over `fetch()`. Its client
 * is already captured as MCP records (one per tool call, one snapshot per
 * `tools/list`), so capturing the same POSTs, SSE GETs and session DELETEs a
 * second time as plain HTTP calls would record every request twice: once as
 * what it is, and once as a REST call with no contract that nothing can check.
 * The HTTP and fetch capture paths skip a request whose URL is a registered
 * MCP endpoint.
 *
 * A match is exact on scheme, host (with a non-default port) and path. The
 * query string is ignored on both sides. A different path on the same host is
 * still captured as HTTP.
 *
 * The set lives on a registered symbol, not in a module variable, so two
 * copies of the SDK in one process (a preload plus a bundled copy) agree on it.
 */
const REGISTRY = Symbol.for('flanj.sdk.mcp-endpoints');

/** Bound on remembered endpoints, so a client built per request cannot grow it without limit. */
export const MAX_MCP_ENDPOINTS = 256;

function registry(): Set<string> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let set = g[REGISTRY] as Set<string> | undefined;
  if (!(set instanceof Set)) {
    set = new Set<string>();
    g[REGISTRY] = set;
  }
  return set;
}

/** `scheme://host[:port]/path`, or undefined when `url` does not parse as an http(s) URL. */
function endpointKey(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}

/** Remember an MCP client's endpoint. A URL that does not parse is ignored. Never throws. */
export function registerMcpEndpoint(url: string | URL | undefined): void {
  if (url === undefined) return;
  const key = endpointKey(String(url));
  if (key === undefined) return;
  const set = registry();
  if (set.has(key)) return;
  if (set.size >= MAX_MCP_ENDPOINTS) {
    // Oldest first: a Set iterates in insertion order.
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}

/** True when `fullUrl` is a registered MCP endpoint, whatever its query string. */
export function isMcpEndpoint(fullUrl: string): boolean {
  const set = (globalThis as Record<PropertyKey, unknown>)[REGISTRY];
  if (!(set instanceof Set) || set.size === 0) return false;
  const key = endpointKey(fullUrl);
  return key !== undefined && set.has(key);
}

/** Test seam: forget every registered endpoint. */
export function clearMcpEndpoints(): void {
  registry().clear();
}

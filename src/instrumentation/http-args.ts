import type { RequestOptions } from 'node:http';
import { URL } from 'node:url';

/**
 * Normalized view of an outgoing http/https request, derived from the many
 * overloaded `request(url, options, cb)` / `request(options, cb)` shapes.
 */
export interface RequestInfo {
  method: string;
  protocol: string; // 'http:' | 'https:'
  /**
   * `host[:port]` — the edge key (CONTRACTS §2 `flanj.peer.host`), with the
   * scheme's DEFAULT port dropped (`:80` on http, `:443` on https). A
   * non-default port is kept: it is a different listener.
   */
  host: string;
  path: string; // path + query
}

type RequestArg = string | URL | RequestOptions;

function isOptions(v: unknown): v is RequestOptions {
  return typeof v === 'object' && v !== null && !(v instanceof URL);
}

/**
 * Parse the leading argument(s) of an http(s).request/get call into a stable
 * {@link RequestInfo}. `defaultProtocol` disambiguates the http vs https module.
 */
export function parseRequestArgs(args: unknown[], defaultProtocol: string): RequestInfo {
  let url: URL | undefined;
  let options: RequestOptions | undefined;

  const first = args[0] as RequestArg | undefined;
  const second = args[1] as RequestArg | undefined;

  if (typeof first === 'string') {
    url = safeUrl(first);
  } else if (first instanceof URL) {
    url = first;
  } else if (isOptions(first)) {
    options = first;
  }
  if (isOptions(second)) {
    options = { ...(options ?? {}), ...second };
  }

  const protocol = options?.protocol ?? url?.protocol ?? defaultProtocol;
  const method = (options?.method ?? 'GET').toUpperCase();

  let host: string;
  let path: string;
  if (url) {
    // WHATWG `URL.host` already omits the scheme's default port.
    host = url.host;
    path = `${url.pathname}${url.search}`;
  } else {
    const hostname = options?.hostname ?? options?.host ?? 'localhost';
    const port = options?.port;
    host = port ? `${hostname}:${port}` : String(hostname);
    path = options?.path ?? '/';
  }

  return { method, protocol, host: stripDefaultPort(host, protocol), path };
}

/**
 * Drop the scheme's DEFAULT port from a `host[:port]`, and only that one.
 *
 * `flanj.peer.host` is the EDGE KEY (CONTRACTS §2), so the same origin must
 * produce the same string however the app dialled it. A URL-string dial goes
 * through WHATWG `URL.host`, which already omits `:443` on https; an
 * options-object dial carrying an explicit `{ port: 443 }` does not — and the
 * two would key as two different edges, so a contract bound to one never
 * validates the other. Any codebase with a shared `{ hostname, port }` http
 * helper hits this.
 *
 * A NON-default port stays: `:8080` is a genuinely different listener, and
 * folding it into the bare host would bind one edge's contract to another's
 * traffic. Idempotent — applied to an already-normalized host it is a no-op.
 */
function stripDefaultPort(host: string, protocol: string): string {
  const defaultPort = { 'http:': '80', 'https:': '443' }[protocol.toLowerCase()];
  if (defaultPort === undefined) return host; // e.g. the MCP path's `mcp:`

  // In `[ipv6]` / `[ipv6]:port` the port can only follow the closing bracket.
  const afterBracket = host.startsWith('[') ? host.indexOf(']') : 0;
  if (afterBracket === -1) return host; // unterminated bracket: leave it alone
  const colon = host.indexOf(':', afterBracket);
  if (colon === -1) return host;
  // Unbracketed and more than one colon => a bare IPv6 literal, not host:port.
  if (afterBracket === 0 && host.includes(':', colon + 1)) return host;

  return host.slice(colon + 1) === defaultPort ? host.slice(0, colon) : host;
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

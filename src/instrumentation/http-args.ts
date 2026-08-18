import type { RequestOptions } from 'node:http';
import { URL } from 'node:url';

/**
 * Normalized view of an outgoing http/https request, derived from the many
 * overloaded `request(url, options, cb)` / `request(options, cb)` shapes.
 */
export interface RequestInfo {
  method: string;
  protocol: string; // 'http:' | 'https:'
  host: string; // host[:port]
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
    host = url.host;
    path = `${url.pathname}${url.search}`;
  } else {
    const hostname = options?.hostname ?? options?.host ?? 'localhost';
    const port = options?.port;
    host = port ? `${hostname}:${port}` : String(hostname);
    path = options?.path ?? '/';
  }

  return { method, protocol, host, path };
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

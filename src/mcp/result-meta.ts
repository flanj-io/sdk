/**
 * Readers for the `_meta` conventions of MCP protocol revision **2026-07-28**.
 *
 * That revision removed the `initialize` / `notifications/initialized`
 * handshake and protocol-level sessions. Everything the v0.5 instrumentation
 * used to learn once, at connect time, now arrives on EVERY result instead:
 *
 *   - `_meta["io.modelcontextprotocol/serverInfo"]` — the server's own name and
 *     version. This is not a nicety: it is the ONLY remaining source of the
 *     stdio edge key (`resolveMcpEdge` keys a local-process edge by
 *     `serverInfo.name`), and it is the corroboration that lets a provider tie
 *     an observation to one of their own releases.
 *   - `traceparent` / `tracestate` / `baggage` — W3C trace context, now with a
 *     documented `_meta` convention. The SDK is an OTel distro; the MCP path
 *     previously carried no trace id at all.
 *   - `resultType` — `complete` or `input_required`. NOT under `_meta`: it is a
 *     top-level result field, read here so every caller reads it one way.
 *
 * Every function is read-only, total, and never throws: a hostile or malformed
 * server must degrade capture, never the app. Unknown values pass through
 * verbatim rather than being coerced to a known set — this collector reports
 * what it saw.
 */

/** The `_meta` key servers identify themselves under (revision 2026-07-28). */
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

/** The `_meta` key a task-bearing result references its task under. */
export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/** `resultType` values this build knows by name. Others are carried verbatim. */
export const RESULT_TYPE_COMPLETE = 'complete';
export const RESULT_TYPE_INPUT_REQUIRED = 'input_required';

/** Server identity as read off one result's `_meta`. All fields optional. */
export interface MetaServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

/** W3C trace context as read off one result's `_meta`. */
export interface MetaTraceContext {
  traceId?: string;
  spanId?: string;
}

/** Read a result's `_meta` map, or undefined when it carries none. */
function metaOf(result: unknown): Record<string, unknown> | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  try {
    const m = (result as { _meta?: unknown })._meta;
    return m !== null && typeof m === 'object' ? (m as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // hostile getter — feature detection never throws
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Server identity from `_meta["io.modelcontextprotocol/serverInfo"]`.
 *
 * Returns undefined — not an empty object — when the key is absent, so callers
 * can tell "this result said nothing about the server" from "this result said
 * the server has no name". Only a result that actually carries identity may
 * overwrite what we already know.
 */
export function serverInfoFromMeta(result: unknown): MetaServerInfo | undefined {
  const meta = metaOf(result);
  if (meta === undefined) return undefined;
  const raw = meta[SERVER_INFO_META_KEY];
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const info: MetaServerInfo = {};
  const name = str(r.name);
  const version = str(r.version);
  const protocolVersion = str(r.protocolVersion);
  if (name !== undefined) info.name = name;
  if (version !== undefined) info.version = version;
  if (protocolVersion !== undefined) info.protocolVersion = protocolVersion;
  return name === undefined && version === undefined && protocolVersion === undefined ? undefined : info;
}

/**
 * W3C trace context from `_meta.traceparent`.
 *
 * `traceparent` is `<version>-<trace-id>-<parent-id>-<flags>`; only the 32-hex
 * trace id and 16-hex span id are lifted, and only when they are well-formed
 * and non-zero. A malformed header yields nothing rather than a bogus id —
 * a wrong correlation key is worse than a missing one, because it points a
 * provider at somebody else's request.
 */
export function traceContextFromMeta(result: unknown): MetaTraceContext | undefined {
  const meta = metaOf(result);
  if (meta === undefined) return undefined;
  const traceparent = str(meta.traceparent);
  if (traceparent === undefined) return undefined;
  const parts = traceparent.split('-');
  if (parts.length < 4) return undefined;
  const [, traceId, spanId] = parts;
  if (!isHex(traceId, 32) || !isHex(spanId, 16)) return undefined;
  if (/^0+$/.test(traceId!) || /^0+$/.test(spanId!)) return undefined; // all-zero = invalid per W3C
  return { traceId: traceId!.toLowerCase(), spanId: spanId!.toLowerCase() };
}

function isHex(v: string | undefined, len: number): boolean {
  return typeof v === 'string' && v.length === len && /^[0-9a-fA-F]+$/.test(v);
}

/**
 * The result's `resultType` (revision 2026-07-28), verbatim.
 *
 * `input_required` is NORMAL traffic on an interactive tool — the server is
 * asking for more input, so the payload is partial by design. It is captured
 * like any other call and marked here; what must never happen is a detector
 * treating that partial payload as a contract violation or as evidence of a
 * shape. Absent on servers still on an older revision, which read as
 * `undefined`, not as `complete`.
 */
export function resultTypeOf(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  try {
    return str((result as { resultType?: unknown }).resultType);
  } catch {
    return undefined;
  }
}

/**
 * The task id when this result is a Tasks HANDLE rather than a payload.
 *
 * Long-running work moved to the Tasks extension: `tools/call` returns
 * `{task: {taskId, status, …}}` immediately and the real payload arrives later
 * via `tasks/get`. Such a result is an ENVELOPE — it describes the task, not
 * what the tool returned — so anything that models response shape must skip it
 * rather than learn the envelope's fields. Read from the `task` object, else
 * from the `related-task` `_meta` key.
 */
export function taskIdOf(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  try {
    const task = (result as { task?: unknown }).task;
    if (task !== null && typeof task === 'object') {
      const id = str((task as Record<string, unknown>).taskId);
      if (id !== undefined) return id;
    }
  } catch {
    /* hostile getter */
  }
  const related = metaOf(result)?.[RELATED_TASK_META_KEY];
  if (related !== null && typeof related === 'object') {
    return str((related as Record<string, unknown>).taskId);
  }
  return str(related);
}

/** Catalog cache directives a `tools/list` result carries (revision 2026-07-28). */
export interface CatalogCacheHints {
  ttlMs?: number;
  cacheScope?: string;
}

/**
 * `ttlMs` / `cacheScope` off a `tools/list` result.
 *
 * Clients are now TOLD to cache catalogs, which is why these matter to us: the
 * snapshot we validate against is whatever the client last fetched, so a tool
 * list may legitimately be up to `ttlMs` behind the server. Carried on the
 * snapshot so a later surface can say how old the contract it checked against
 * may be, instead of implying it is live.
 */
export function catalogCacheHints(result: unknown): CatalogCacheHints | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const hints: CatalogCacheHints = {};
  const ttl = r.ttlMs;
  if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0) hints.ttlMs = ttl;
  const scope = str(r.cacheScope);
  if (scope !== undefined) hints.cacheScope = scope;
  return hints.ttlMs === undefined && hints.cacheScope === undefined ? undefined : hints;
}

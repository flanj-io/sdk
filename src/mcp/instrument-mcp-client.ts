import type { Logger } from '@opentelemetry/api-logs';
import { assembleContractSnapshot } from './assemble-contract-snapshot';
import { assembleMcpCall } from './assemble-mcp-call';
import { emitContractSnapshot, emitMcpCall } from './mcp-record';
import { resolveMcpEdge } from './resolve-mcp-edge';
import type { McpCapturedCall, McpContractSnapshot, McpServerIdentity, McpServerKind } from './mcp-types';

/**
 * The structural surface the wrapper feature-detects. BOTH supported package
 * lines satisfy it: `@modelcontextprotocol/sdk` 1.x (`Client` — `getServerVersion()`,
 * `callTool({name, arguments})`) and `@modelcontextprotocol/client` 2.x
 * (`serverInfo` / `protocolVersion` properties, `callTool(name, args)`). Every
 * member is optional and read defensively; there is NO import of either
 * package — they are optional peers, detected at runtime.
 */
export interface McpClientLike {
  listTools?(...args: unknown[]): Promise<unknown>;
  callTool?(...args: unknown[]): Promise<unknown>;
  getServerVersion?(): { name?: string; version?: string } | undefined;
  getServerCapabilities?(): { tools?: { listChanged?: boolean } } | undefined;
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  transport?: unknown;
  fallbackNotificationHandler?: (notification: unknown) => Promise<void> | void;
}

export interface InstrumentMcpClientOptions {
  /** Integration id emitted as `flanj.integration`, e.g. `acme-payments`. */
  integration: string;
  /** Streamable-HTTP endpoint URL — the edge key host. Detected from the transport when omitted. */
  endpoint?: string;
  /** Force the server kind; detected from the transport when omitted. */
  serverKind?: McpServerKind;
  /** Body capture cap in bytes (same default as the HTTP path). */
  bodyCapBytes?: number;
  /** Emit records through this OTLP logger (e.g. `handle.loggerProvider.getLogger(...)`). */
  logger?: Logger;
  /** Sink for each captured, redacted tool call (in addition to `logger`). */
  onCapture?: (call: McpCapturedCall) => void;
  /** Sink for each complete observed `tools/list` (in addition to `logger`). */
  onSnapshot?: (snap: McpContractSnapshot) => void;
  /**
   * Refetch + re-snapshot on `notifications/tools/list_changed` (via the
   * client's fallback notification handler, chained — the app's own handler
   * still runs). Default true.
   */
  refetchOnListChanged?: boolean;
}

const INSTRUMENTED = Symbol.for('flanj.mcp.instrumented');
const SEND_OBSERVERS = Symbol.for('flanj.mcp.sendObservers');
/** Bound on remembered-but-unclaimed JSON-RPC ids (hostile/odd clients cannot grow it unbounded). */
const MAX_PENDING_IDS = 1024;

/**
 * Per-transport send-observation registry (stored on the transport under
 * {@link SEND_OBSERVERS}). The transport's `send` is wrapped exactly ONCE; the
 * registry keys one observer per (transport, client), so two instrumented
 * clients sharing one transport each observe only their own requests — and
 * dropping one client's observer (or the client being collected; the WeakRefs
 * keep the registry leak-free) never breaks the other's observation.
 */
interface SendObserverRegistry {
  /** The client whose wrapped callTool is on the stack — its send is attributed to it. */
  current: WeakRef<object> | null;
  observers: { clientRef: WeakRef<object>; observe: (message: unknown) => void }[];
}

/** Route one outgoing message to the observer of the client that is sending it. */
function deliverToSendObserver(registry: SendObserverRegistry, message: unknown): void {
  // Self-clean observers whose client was collected.
  for (let i = registry.observers.length - 1; i >= 0; i--) {
    if (registry.observers[i]!.clientRef.deref() === undefined) registry.observers.splice(i, 1);
  }
  const sender = registry.current?.deref();
  if (sender !== undefined) {
    registry.observers.find((o) => o.clientRef.deref() === sender)?.observe(message);
    return;
  }
  // No attributed sender (a transport that defers its send past the callTool
  // window): unambiguous only when a single client observes this transport —
  // never guess between two.
  if (registry.observers.length === 1) registry.observers[0]!.observe(message);
}

/**
 * Wrap an MCP **Client** (v0.5 spec §4.B). Strictly out-of-band: the wrapper
 * NEVER changes a call, a result, or an error — arguments pass through
 * verbatim, results are returned untouched, rejections propagate unchanged,
 * and every capture step is fenced so a capture failure means "we stopped
 * collecting", never "the agent broke".
 *
 *  - `listTools` → one `contract_snapshot` record per COMPLETE list
 *    (pagination followed via the cursor chain the caller drives).
 *  - `callTool` → one captured call record on the RedactedCall shape
 *    (arguments/result floor-redacted at source).
 *  - JSON-RPC ids are observed on the client's own outgoing messages and
 *    labeled CLIENT-generated (`flanj.corr.client_request_id`).
 *
 * Returns the same client instance. Idempotent.
 */
export function instrumentMcpClient<T extends McpClientLike>(client: T, options: InstrumentMcpClientOptions): T {
  const c = client as McpClientLike & Record<PropertyKey, unknown>;
  if (c[INSTRUMENTED] === true) return client;
  c[INSTRUMENTED] = true;

  const state = {
    /**
     * The in-flight listTools cursor chain; null = none. `expectedCursor` is
     * the next cursor the chain is waiting for — pages are keyed to the chain
     * by it, so an interleaved chain can never corrupt the accumulator.
     */
    chain: null as { tools: unknown[]; expectedCursor: unknown } | null,
    /** Observed-but-unclaimed client-generated JSON-RPC ids, FIFO per tool name. */
    pendingIds: [] as { tool: string; id: string }[],
    refetching: false
  };

  /** One stable weak handle to THIS client, used to key its send observation. */
  const clientRef = new WeakRef(c as object);

  const serverIdentity = (): McpServerIdentity => {
    const id: McpServerIdentity = {};
    try {
      const info = typeof c.getServerVersion === 'function' ? c.getServerVersion() : c.serverInfo;
      if (info && typeof info === 'object') {
        if (typeof info.name === 'string') id.name = info.name;
        if (typeof info.version === 'string') id.version = info.version;
      }
      const proto =
        typeof c.protocolVersion === 'string'
          ? c.protocolVersion
          : transportProp(c.transport, 'protocolVersion');
      if (typeof proto === 'string') id.protocolVersion = proto;
      const caps = typeof c.getServerCapabilities === 'function' ? c.getServerCapabilities() : undefined;
      const listChanged = caps?.tools?.listChanged;
      if (typeof listChanged === 'boolean') id.listChanged = listChanged;
    } catch {
      /* capture-side only — never disturb the app */
    }
    return id;
  };

  const edge = () => {
    const server = serverIdentity();
    return {
      server,
      ...resolveMcpEdge({
        endpoint: options.endpoint,
        serverKind: options.serverKind,
        transport: c.transport,
        serverName: server.name
      })
    };
  };

  /** THIS client's observer: remember its client-generated tools/call JSON-RPC ids. */
  const observeSentMessage = (message: unknown): void => {
    const msg = message as { method?: unknown; id?: unknown; params?: { name?: unknown } } | undefined;
    if (msg && msg.method === 'tools/call' && msg.id !== undefined && typeof msg.params?.name === 'string') {
      if (state.pendingIds.length >= MAX_PENDING_IDS) state.pendingIds.shift();
      state.pendingIds.push({ tool: msg.params.name, id: String(msg.id) });
    }
  };

  /**
   * Observe (never alter) the client's outgoing messages for tools/call
   * JSON-RPC ids. The transport's `send` is wrapped ONCE per transport; this
   * client's observer is registered in the transport's per-client registry —
   * see {@link SendObserverRegistry}.
   */
  const observeTransportSend = (): void => {
    try {
      const t = c.transport as (Record<PropertyKey, unknown> & { send?: (...a: unknown[]) => unknown }) | undefined;
      if (!t || typeof t.send !== 'function') return;
      let registry = t[SEND_OBSERVERS] as SendObserverRegistry | undefined;
      if (registry === undefined) {
        const reg: SendObserverRegistry = { current: null, observers: [] };
        registry = reg;
        t[SEND_OBSERVERS] = reg;
        const origSend = t.send;
        t.send = function (this: unknown, ...sendArgs: unknown[]): unknown {
          try {
            deliverToSendObserver(reg, sendArgs[0]);
          } catch {
            /* observation only */
          }
          return origSend.apply(this, sendArgs);
        };
      }
      if (!registry.observers.some((o) => o.clientRef.deref() === c)) {
        registry.observers.push({ clientRef, observe: observeSentMessage });
      }
    } catch {
      /* observation only */
    }
  };

  /**
   * Mark THIS client as the sender on its transport's registry for the
   * synchronous window of a callTool (both supported package lines send the
   * JSON-RPC request synchronously inside `callTool`). Returns the (idempotent)
   * un-marker.
   */
  const beginSendAttribution = (): (() => void) => {
    try {
      const t = c.transport as Record<PropertyKey, unknown> | null | undefined;
      const registry = t?.[SEND_OBSERVERS] as SendObserverRegistry | undefined;
      if (registry === undefined) return () => undefined;
      const prev = registry.current;
      registry.current = clientRef;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        registry.current = prev;
      };
    } catch {
      return () => undefined;
    }
  };

  const claimClientRequestId = (tool: string): string | undefined => {
    const i = state.pendingIds.findIndex((p) => p.tool === tool);
    if (i === -1) return undefined;
    const [claimed] = state.pendingIds.splice(i, 1);
    return claimed?.id;
  };

  const sinkCall = (call: McpCapturedCall): void => {
    if (options.logger) emitMcpCall(options.logger, call);
    options.onCapture?.(call);
  };
  const sinkSnapshot = (snap: McpContractSnapshot): void => {
    if (options.logger) emitContractSnapshot(options.logger, snap);
    options.onSnapshot?.(snap);
  };

  const captureCall = (toolName: string, args: unknown, result: unknown, isError: boolean, startedAt: number): void => {
    try {
      const e = edge();
      sinkCall(
        assembleMcpCall({
          integration: options.integration,
          peerHost: e.peerHost,
          edgeClass: e.edgeClass,
          serverKind: e.serverKind,
          toolName,
          args,
          result,
          isError,
          serverName: e.server.name,
          serverVersion: e.server.version,
          protocolVersion: e.server.protocolVersion,
          sessionId: sessionIdOf(c.transport),
          clientRequestId: claimClientRequestId(toolName),
          durationMs: Math.max(0, Math.round(Date.now() - startedAt)),
          bodyCapBytes: options.bodyCapBytes
        })
      );
    } catch {
      /* capture failure = we stopped collecting, never "the agent broke" */
    }
  };

  const emitSnapshotOf = (tools: unknown[]): void => {
    try {
      const e = edge();
      sinkSnapshot(
        assembleContractSnapshot({
          integration: options.integration,
          peerHost: e.peerHost,
          edgeClass: e.edgeClass,
          serverKind: e.serverKind,
          server: e.server,
          tools
        })
      );
    } catch {
      /* capture-side only */
    }
  };

  /**
   * Fold one listTools page into the in-flight chain; emit when the chain
   * completes. Pages are KEYED to the chain: a head page (no cursor) starts a
   * new chain (superseding any in-flight one), and a cursor page is folded in
   * only when its cursor is the chain's expected next cursor. A page whose
   * cursor does not match the in-flight chain is DISCARDED — a superseded or
   * interleaved chain simply produces no snapshot, never a partial/mixed one.
   */
  const accumulatePage = (cursor: unknown, result: unknown): void => {
    try {
      if (result === null || typeof result !== 'object') return;
      const r = result as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(r.tools)) return;
      if (cursor === undefined || cursor === null) {
        state.chain = { tools: [], expectedCursor: undefined };
      } else if (state.chain === null || state.chain.expectedCursor !== cursor) {
        return; // a page of a chain that is not in flight (head unseen, superseded, or interleaved): discard
      }
      state.chain.tools.push(...r.tools);
      if (r.nextCursor === undefined || r.nextCursor === null || r.nextCursor === '') {
        const complete = state.chain.tools;
        state.chain = null;
        emitSnapshotOf(complete);
      } else {
        state.chain.expectedCursor = r.nextCursor;
      }
    } catch {
      state.chain = null;
    }
  };

  if (typeof c.listTools === 'function') {
    const origListTools = c.listTools as (...a: unknown[]) => Promise<unknown>;
    c.listTools = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const cursor = cursorOf(args[0]);
      const p = origListTools.apply(this === c || this === undefined ? c : this, args);
      return p.then(
        (res) => {
          accumulatePage(cursor, res);
          return res;
        },
        (err) => {
          // A failed page ends ITS chain (matched by cursor); never emit a partial
          // list. A failed page of some OTHER chain leaves the in-flight one alone.
          if (cursor !== undefined && cursor !== null && state.chain !== null && state.chain.expectedCursor === cursor) {
            state.chain = null;
          }
          throw err;
        }
      );
    };
  }

  if (typeof c.callTool === 'function') {
    const origCallTool = c.callTool as (...a: unknown[]) => Promise<unknown>;
    c.callTool = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      observeTransportSend();
      const { toolName, toolArgs } = parseCallToolArgs(args);
      const startedAt = Date.now();
      const endAttribution = beginSendAttribution();
      let p: Promise<unknown> | undefined;
      try {
        p = origCallTool.apply(this === c || this === undefined ? c : this, args);
      } finally {
        endAttribution(); // the send happened synchronously inside — un-mark before returning
      }
      return p.then(
        (res) => {
          captureCall(toolName, toolArgs, res, isErrorResult(res), startedAt);
          return res;
        },
        (err) => {
          // The call happened and failed: record it (no response body), rethrow untouched.
          captureCall(toolName, toolArgs, undefined, true, startedAt);
          throw err;
        }
      );
    };
  }

  if (options.refetchOnListChanged !== false && 'fallbackNotificationHandler' in c) {
    const prev = c.fallbackNotificationHandler;
    c.fallbackNotificationHandler = async (notification: unknown): Promise<void> => {
      try {
        const method = (notification as { method?: unknown } | undefined)?.method;
        if (method === 'notifications/tools/list_changed' && !state.refetching) {
          state.refetching = true;
          void refetchAllTools(c)
            .catch(() => undefined)
            .finally(() => {
              state.refetching = false;
            });
        }
      } catch {
        /* capture-side only */
      }
      if (typeof prev === 'function') await prev.call(c, notification);
    };
  }

  return client;
}

/** Drive the (already wrapped) listTools through its cursor chain — the wrapped path emits the snapshot. */
async function refetchAllTools(c: McpClientLike): Promise<void> {
  if (typeof c.listTools !== 'function') return;
  let cursor: unknown;
  // Bounded: a hostile cursor chain cannot loop forever.
  for (let page = 0; page < 1000; page++) {
    const res = (await c.listTools(cursor === undefined ? undefined : { cursor })) as {
      nextCursor?: unknown;
    } | null;
    const next = res?.nextCursor;
    if (next === undefined || next === null || next === '') return;
    cursor = next;
  }
}

/** Both call shapes: 1.x `callTool({name, arguments})` and 2.x `callTool(name, args)`. */
function parseCallToolArgs(args: unknown[]): { toolName: string; toolArgs: unknown } {
  const a0 = args[0];
  if (typeof a0 === 'string') return { toolName: a0, toolArgs: args[1] };
  if (a0 !== null && typeof a0 === 'object') {
    const p = a0 as { name?: unknown; arguments?: unknown };
    return { toolName: typeof p.name === 'string' ? p.name : 'unknown-tool', toolArgs: p.arguments };
  }
  return { toolName: 'unknown-tool', toolArgs: undefined };
}

function isErrorResult(result: unknown): boolean {
  return result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true;
}

function cursorOf(params: unknown): unknown {
  if (params === null || typeof params !== 'object') return undefined;
  return (params as { cursor?: unknown }).cursor;
}

function transportProp(transport: unknown, key: string): unknown {
  if (transport === null || typeof transport !== 'object') return undefined;
  try {
    return (transport as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function sessionIdOf(transport: unknown): string | undefined {
  const v = transportProp(transport, 'sessionId');
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

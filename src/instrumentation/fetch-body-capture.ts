import { context, trace, type SpanContext } from '@opentelemetry/api';
import { SDK_NAME, SDK_VERSION } from '../version';
import { FlanjInstrumentation } from './flanj-instrumentation';
import { CappedBuffer } from './capped-buffer';
import { assembleCapturedCall } from './assemble-call';
import { decodeBody } from './decode-body';
import { classifyHost, type EdgeClass } from './classify-host';
import { DEFAULT_BODY_CAP_BYTES, HttpBodyCaptureConfig, isIgnoredUrl } from './config';
import { teeRequestBody } from './tee-request-body';
import { teeDispatchHandler, type DispatchObserver } from './tee-dispatch-handler';
import { normalizeUndiciHeaders } from './undici-headers';
import { undiciGlobalDispatcher } from './undici-global-dispatcher';
import type { DispatchFn, DispatchHandler, DispatchInterceptor, DispatchOptions, UndiciDispatcher } from './undici-types';

/**
 * Which live instance owns the fetch layer, process-wide. A registered symbol
 * rather than a module variable, so two copies of the SDK in one process (a
 * preload plus a bundled copy) still agree that only one captures.
 */
const OWNER = Symbol.for('flanj.sdk.fetch-capture.owner');

interface Owner {
  isLive(): boolean;
}

interface InstalledLayer {
  /** The dispatcher we composed onto, restored on `disable()` while ours is still on top. */
  base: UndiciDispatcher;
  /** What we installed as the global dispatcher. */
  composed: UndiciDispatcher;
  owner: Owner;
}

type HeaderMap = Record<string, string | string[]>;

/**
 * EGRESS capture for global `fetch()` — Node's bundled undici, which has its own
 * socket path and never touches `node:http`. It emits the SAME `CapturedCall`
 * the http client path does (CONTRACTS §2 is unchanged), through the same
 * assembler, so the floor, the caps, the content-type gate, the header
 * allowlist and the edge rule are shared rather than re-implemented.
 *
 * **The hook.** `start()` composes an interceptor onto undici's global
 * dispatcher (`getGlobalDispatcher().compose(…)` then install, the two halves
 * of `setGlobalDispatcher`). Every `fetch()` that does not pass its own
 * `dispatcher` goes through it. `globalThis.fetch` is never replaced. The
 * interceptor observes; it never answers, retries or rewrites a request.
 *
 * **Bodies.** The request body is teed on its way to the socket
 * (`tee-request-body.ts`); the response body is copied as the handler callbacks
 * deliver it (`tee-dispatch-handler.ts`, both handler APIs). Both are the raw
 * wire bytes, capped at `bodyCapBytes`; a response `content-encoding` is undone
 * by `decodeBody` exactly as on the http path, then the floor redacts and the
 * raw buffers go out of scope. Internal edges tee nothing.
 *
 * **Coexistence.** Composition STACKS: the dispatcher already installed — an
 * app's proxy agent, or another interceptor — stays underneath and keeps
 * running. `@opentelemetry/instrumentation-undici` observes through
 * `diagnostics_channel` and composes nothing, so it is unaffected in either
 * order. `disable()` removes our layer only while it is still the outermost
 * one; buried under a later layer it stays, inert (every dispatch checks
 * `isEnabled()`), because removing it would drop whatever was stacked on top.
 *
 * **One live layer.** A second instance started in the same process (a
 * preload plus a `start()` from code) finds a live owner and installs nothing,
 * so the same call is never captured twice. The first live one captures —
 * the same rule as the http path.
 *
 * **Not reachable:** a `fetch()` given its own `dispatcher`, a global
 * dispatcher an app installs AFTER `start()`, and a library that replaces
 * `globalThis.fetch` with an implementation that is not Node's.
 */
export class FetchBodyCaptureInstrumentation extends FlanjInstrumentation<HttpBodyCaptureConfig> {
  /** `declare`: the base constructor runs patch() before a field initializer would reset this. */
  declare private layer: InstalledLayer | undefined;

  constructor(config: HttpBodyCaptureConfig) {
    super(`${SDK_NAME}/instrumentation-fetch-body-capture`, SDK_VERSION, config);
  }

  /** True while this instance's layer is installed and capturing `fetch()`. */
  isCapturing(): boolean {
    return this.isEnabled() && this.layer !== undefined;
  }

  protected patch(): void {
    try {
      const registry = globalThis as unknown as Record<symbol, Owner | undefined>;
      if (registry[OWNER]?.isLive()) return;
      const base = undiciGlobalDispatcher.get();
      if (!base) return;
      const composed = compose(base, (dispatch) => (opts, handler) => this.dispatchThrough(dispatch, opts, handler));
      const owner: Owner = { isLive: () => this.isEnabled() && this.layer?.owner === owner };
      this.layer = { base, composed, owner };
      undiciGlobalDispatcher.set(composed);
      registry[OWNER] = owner;
    } catch {
      // Could not install: fetch() keeps working, uncaptured. Never fail start().
      this.layer = undefined;
    }
  }

  protected unpatch(): void {
    const layer = this.layer;
    if (!layer) return;
    this.layer = undefined;
    try {
      if (undiciGlobalDispatcher.get() === layer.composed) undiciGlobalDispatcher.set(layer.base);
      const registry = globalThis as unknown as Record<symbol, Owner | undefined>;
      if (registry[OWNER] === layer.owner) delete registry[OWNER];
    } catch {
      // Leaving an inert layer installed is safe; throwing from shutdown() is not.
    }
  }

  private dispatchThrough(dispatch: DispatchFn, opts: DispatchOptions, handler: DispatchHandler): unknown {
    if (!this.isEnabled()) return dispatch(opts, handler);
    let sendOpts = opts;
    let sendHandler = handler;
    try {
      const tap = this.begin(opts);
      if (tap) {
        sendHandler = teeDispatchHandler(handler, tap.observer);
        sendOpts = tap.opts;
      }
    } catch {
      // Any capture failure: dispatch exactly what the app asked for. The tee
      // generator (if one was built) is lazy and has pulled nothing yet.
      sendOpts = opts;
      sendHandler = handler;
    }
    return dispatch(sendOpts, sendHandler);
  }

  private begin(opts: DispatchOptions): { opts: DispatchOptions; observer: DispatchObserver } | undefined {
    // A protocol upgrade (WebSocket) is not a request/response call.
    if (opts.upgrade) return undefined;
    const origin = parseOrigin(opts.origin);
    if (!origin) return undefined;

    const cfg = this.getConfig();
    const cap = cfg.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    const path = typeof opts.path === 'string' && opts.path.length > 0 ? opts.path : '/';
    const method = (typeof opts.method === 'string' ? opts.method : 'GET').toUpperCase();

    // Never capture the SDK's own export (or any other ignored destination).
    if (isIgnoredUrl(`${origin.protocol}//${origin.host}${path}`, cfg.ignoreUrls)) return undefined;

    // Classify the DESTINATION. Internal edges are metadata-only: nothing is teed.
    const edgeClass = classifyHost(origin.host);
    const captureBodies = edgeClass === 'external';

    const reqBuf = new CappedBuffer(cap);
    let sendOpts = opts;
    let pending: Promise<void> | undefined;
    if (captureBodies && opts.body !== null && opts.body !== undefined) {
      const teed = teeRequestBody(opts.body, reqBuf, cap);
      if (teed.body !== opts.body) sendOpts = { ...opts, body: teed.body };
      pending = teed.pending;
    }

    const observer = this.observe({
      method,
      protocol: origin.protocol,
      host: origin.host,
      path,
      requestHeaders: normalizeUndiciHeaders(opts.headers),
      reqBuf,
      pending,
      edgeClass,
      captureBodies,
      cap,
      startTime: Date.now(),
      spanCtx: trace.getSpanContext(context.active())
    });
    return { opts: sendOpts, observer };
  }

  private observe(call: {
    method: string;
    protocol: string;
    host: string;
    path: string;
    requestHeaders: HeaderMap;
    reqBuf: CappedBuffer;
    pending: Promise<void> | undefined;
    edgeClass: EdgeClass;
    captureBodies: boolean;
    cap: number;
    startTime: number;
    spanCtx: SpanContext | undefined;
  }): DispatchObserver {
    let statusCode = 0;
    let responseHeaders: HeaderMap = {};
    let resBuf = new CappedBuffer(call.cap);
    let started = false;
    let settled = false;

    const emit = (): void => {
      try {
        this.getConfig().onCapture?.(this.buildCall(call, statusCode, responseHeaders, resBuf));
      } catch {
        // swallow — never surface capture errors to the app
      }
    };

    return {
      onResponseStart: (status, headers) => {
        // 1xx interim responses precede the real one; only a final status counts.
        if (status < 200) return;
        started = true;
        statusCode = status;
        responseHeaders = headers;
        resBuf = new CappedBuffer(call.cap);
      },
      onResponseData: (chunk) => {
        if (started && call.captureBodies) resBuf.append(chunk);
      },
      onResponseEnd: () => {
        if (!started || settled) return;
        settled = true;
        if (call.pending) void call.pending.then(emit, emit);
        else emit();
      },
      onAbandon: () => {
        // An error, abort or upgrade: like the http path, no record for a
        // response that never completed.
        settled = true;
      }
    };
  }

  private buildCall(
    call: Parameters<FetchBodyCaptureInstrumentation['observe']>[0],
    statusCode: number,
    responseHeaders: HeaderMap,
    resBuf: CappedBuffer
  ) {
    const cfg = this.getConfig();
    const req = call.requestHeaders;
    const res = responseHeaders;
    // Wire bytes, exactly as on the http path: undo `content-encoding` before
    // the redactor sees them; a coding we cannot undo keeps no body.
    const reqBody = decodeBody(call.reqBuf.toBuffer(), pick(req, 'content-encoding'), call.cap, call.reqBuf.truncated);
    const resBody = decodeBody(resBuf.toBuffer(), pick(res, 'content-encoding'), call.cap, resBuf.truncated);

    return assembleCapturedCall({
      direction: 'client',
      peerHost: call.host,
      edgeClass: call.edgeClass,
      captureBodies: call.captureBodies,
      method: call.method,
      protocol: call.protocol,
      host: call.host,
      path: call.path,
      statusCode,
      reqContentType: pick(req, 'content-type'),
      resContentType: pick(res, 'content-type'),
      reqBodyRaw: reqBody.text,
      reqBodyTruncated: reqBody.truncated,
      resBodyRaw: resBody.text,
      resBodyTruncated: resBody.truncated,
      requestHeaders: req,
      responseHeaders: res,
      correlation: {
        requestId:
          pick(res, 'x-request-id') ??
          pick(res, 'x-correlation-id') ??
          pick(req, 'x-request-id') ??
          pick(req, 'x-correlation-id'),
        idempotencyKey: pick(req, 'idempotency-key') ?? pick(res, 'idempotency-key'),
        traceId: call.spanCtx?.traceId,
        spanId: call.spanCtx?.spanId
      },
      durationMs: Date.now() - call.startTime,
      captureContentTypes: cfg.captureContentTypes,
      headerAllowlist: cfg.headerAllowlist
    });
  }
}

/**
 * Compose `interceptor` onto `base`. Every undici Node bundles (6.18+) has
 * `compose`; a userland dispatcher an app installed before `start()` may be
 * older, so fall back to what undici 7's `compose` itself returns — a view of
 * the base whose `dispatch` is the intercepted one, everything else the base's.
 */
function compose(base: UndiciDispatcher, interceptor: DispatchInterceptor): UndiciDispatcher {
  if (typeof base.compose === 'function') return base.compose(interceptor);
  const dispatch = interceptor(base.dispatch.bind(base));
  return new Proxy(base, {
    get(target, key) {
      if (key === 'dispatch') return dispatch;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    }
  });
}

/** `{ protocol, host }` of a dispatch origin; `host` via WHATWG `URL.host` (the scheme's default port dropped). */
function parseOrigin(origin: DispatchOptions['origin']): { protocol: string; host: string } | undefined {
  if (origin === undefined || origin === null) return undefined;
  try {
    const url = origin instanceof URL ? origin : new URL(String(origin));
    return url.host ? { protocol: url.protocol, host: url.host } : undefined;
  } catch {
    return undefined;
  }
}

function pick(headers: HeaderMap, key: string): string | undefined {
  const v = headers[key];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

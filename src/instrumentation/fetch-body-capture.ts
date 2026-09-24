import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { context, trace, type SpanContext } from '@opentelemetry/api';
import { SDK_NAME, SDK_VERSION } from '../version';
import { FlanjInstrumentation } from './flanj-instrumentation';
import { CappedBuffer } from './capped-buffer';
import { assembleCapturedCall } from './assemble-call';
import { decodeBody } from './decode-body';
import { classifyHost, type EdgeClass } from './classify-host';
import { DEFAULT_BODY_CAP_BYTES, HttpBodyCaptureConfig, isIgnoredUrl } from './config';
import { isMcpEndpoint } from './mcp-endpoints';
import { teeRequestBody } from './tee-request-body';
import { teeDispatchHandler, type DispatchObserver } from './tee-dispatch-handler';
import { normalizeUndiciHeaders } from './undici-headers';
import { headerValue } from './header-value';
import { correlationIds } from './correlation-ids';
import { undiciGlobalDispatcher, type InstalledDispatchers } from './undici-global-dispatcher';
import type { DispatchFn, DispatchHandler, DispatchOptions } from './undici-types';

/**
 * Which live instance owns the fetch layer, process-wide. A registered symbol
 * rather than a module variable, so two copies of the SDK in one process (a
 * preload plus a bundled copy) still agree that only one captures.
 */
const OWNER = Symbol.for('flanj.sdk.fetch-capture.owner');

interface Owner {
  isLive(): boolean;
}

/**
 * undici publishes every request it builds here, synchronously, from inside the
 * dispatch that built it. Instrumentations that add headers
 * (`@opentelemetry/instrumentation-undici`'s `traceparent`, for one) do it in a
 * subscriber, on that internal request — after our interceptor has run.
 */
const REQUEST_CREATE = 'undici:request:create';

/** The fields of undici's internal request object the capture reads. */
interface UndiciRequest {
  origin?: unknown;
  path?: unknown;
  method?: unknown;
  /** Flat `[name, value, …]`, including every header a subscriber added. */
  headers?: unknown;
}

/** One dispatch in progress, waiting for undici to build its request. */
interface PendingDispatch {
  host: string;
  path: string;
  method: string;
  request?: UndiciRequest;
}

interface InstalledLayer {
  dispatchers: InstalledDispatchers;
  owner: Owner;
  /** Dispatches currently inside `dispatch()`, innermost last. */
  inFlight: PendingDispatch[];
  onRequestCreate: (message: unknown) => void;
}

type HeaderMap = Record<string, string | string[]>;

/** One `fetch()` hop being captured: what was known at dispatch, and where its bodies accumulate. */
interface FetchCall {
  method: string;
  protocol: string;
  host: string;
  path: string;
  /** At dispatch; replaced at response start by the headers that went on the wire. */
  requestHeaders: HeaderMap;
  /** Filled with undici's own request object if one was built inside our dispatch. */
  pending: PendingDispatch;
  reqBuf: CappedBuffer;
  /** Settles once an asynchronous request-body copy (a Blob's) is in `reqBuf`. */
  bodyRead: Promise<void> | undefined;
  edgeClass: EdgeClass;
  captureBodies: boolean;
  cap: number;
  startTime: number;
  spanCtx: SpanContext | undefined;
}

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
      const inFlight: PendingDispatch[] = [];
      const onRequestCreate = (message: unknown): void => claimRequest(inFlight, message);
      const dispatchers = undiciGlobalDispatcher.install(
        (dispatch) => (opts, handler) => this.dispatchThrough(dispatch, opts, handler, inFlight)
      );
      if (!dispatchers) return;
      const owner: Owner = { isLive: () => this.isEnabled() && this.layer?.owner === owner };
      this.layer = { dispatchers, owner, inFlight, onRequestCreate };
      registry[OWNER] = owner;
      subscribe(REQUEST_CREATE, onRequestCreate);
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
      unsubscribe(REQUEST_CREATE, layer.onRequestCreate);
      undiciGlobalDispatcher.uninstall(layer.dispatchers);
      const registry = globalThis as unknown as Record<symbol, Owner | undefined>;
      if (registry[OWNER] === layer.owner) delete registry[OWNER];
    } catch {
      // Leaving an inert layer installed is safe; throwing from shutdown() is not.
    }
  }

  private dispatchThrough(
    dispatch: DispatchFn,
    opts: DispatchOptions,
    handler: DispatchHandler,
    inFlight: PendingDispatch[]
  ): unknown {
    if (!this.isEnabled()) return dispatch(opts, handler);
    let sendOpts = opts;
    let sendHandler = handler;
    let pending: PendingDispatch | undefined;
    try {
      const tap = this.begin(opts);
      if (tap) {
        sendHandler = teeDispatchHandler(handler, tap.observer);
        sendOpts = tap.opts;
        pending = tap.pending;
      }
    } catch {
      // Any capture failure: dispatch exactly what the app asked for. The tee
      // generator (if one was built) is lazy and has pulled nothing yet.
      sendOpts = opts;
      sendHandler = handler;
      pending = undefined;
    }
    if (!pending) return dispatch(sendOpts, sendHandler);
    // While the next dispatcher runs, undici builds its request and publishes it
    // on REQUEST_CREATE; `claimRequest` pairs it with this call.
    inFlight.push(pending);
    try {
      return dispatch(sendOpts, sendHandler);
    } finally {
      inFlight.pop();
    }
  }

  private begin(
    opts: DispatchOptions
  ): { opts: DispatchOptions; observer: DispatchObserver; pending: PendingDispatch } | undefined {
    // A protocol upgrade (WebSocket) is not a request/response call.
    if (opts.upgrade) return undefined;
    const origin = parseOrigin(opts.origin);
    if (!origin) return undefined;

    const cfg = this.getConfig();
    const cap = cfg.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    const path = typeof opts.path === 'string' && opts.path.length > 0 ? opts.path : '/';
    const method = (typeof opts.method === 'string' ? opts.method : 'GET').toUpperCase();

    // Never capture the SDK's own export (or any other ignored destination).
    const fullUrl = `${origin.protocol}//${origin.host}${path}`;
    if (isIgnoredUrl(fullUrl, cfg.ignoreUrls)) return undefined;
    // An instrumented MCP client's own transport: already captured as MCP records.
    if (isMcpEndpoint(fullUrl)) return undefined;

    // Classify the DESTINATION. Internal edges are metadata-only: nothing is teed.
    const edgeClass = classifyHost(origin.host);
    const captureBodies = edgeClass === 'external';

    const reqBuf = new CappedBuffer(cap);
    let sendOpts = opts;
    let bodyRead: Promise<void> | undefined;
    if (captureBodies && opts.body !== null && opts.body !== undefined) {
      const teed = teeRequestBody(opts.body, reqBuf, cap);
      if (teed.body !== opts.body) sendOpts = { ...opts, body: teed.body };
      bodyRead = teed.pending;
    }

    const pending: PendingDispatch = { host: origin.host, path, method };
    const observer = this.observe({
      method,
      protocol: origin.protocol,
      host: origin.host,
      path,
      requestHeaders: normalizeUndiciHeaders(opts.headers),
      pending,
      reqBuf,
      bodyRead,
      edgeClass,
      captureBodies,
      cap,
      startTime: Date.now(),
      spanCtx: trace.getSpanContext(context.active())
    });
    return { opts: sendOpts, observer, pending };
  }

  private observe(call: FetchCall): DispatchObserver {
    let statusCode = 0;
    let requestHeaders = call.requestHeaders;
    let responseHeaders: HeaderMap = {};
    let resBuf = new CappedBuffer(call.cap);
    let started = false;
    let settled = false;

    const emit = (): void => {
      try {
        this.getConfig().onCapture?.(this.buildCall({ ...call, requestHeaders }, statusCode, responseHeaders, resBuf));
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
        // Request headers as they went on the wire, read NOW — like the http
        // path's `getHeader()` at response time — so headers other
        // instrumentations added after our interceptor ran are on the record.
        const sent = call.pending.request?.headers;
        if (sent !== undefined) requestHeaders = { ...call.requestHeaders, ...normalizeUndiciHeaders(sent) };
        resBuf = new CappedBuffer(call.cap);
      },
      onResponseData: (chunk) => {
        if (started && call.captureBodies) resBuf.append(chunk);
      },
      onResponseEnd: () => {
        if (!started || settled) return;
        settled = true;
        if (call.bodyRead) void call.bodyRead.then(emit, emit);
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
    call: FetchCall,
    statusCode: number,
    responseHeaders: HeaderMap,
    resBuf: CappedBuffer
  ) {
    const cfg = this.getConfig();
    const req = call.requestHeaders;
    const res = responseHeaders;
    // Wire bytes, exactly as on the http path: undo `content-encoding` before
    // the redactor sees them; a coding we cannot undo keeps no body.
    const reqBody = decodeBody(call.reqBuf.toBuffer(), headerValue(req['content-encoding']), call.cap, call.reqBuf.truncated);
    const resBody = decodeBody(resBuf.toBuffer(), headerValue(res['content-encoding']), call.cap, resBuf.truncated);

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
      reqContentType: headerValue(req['content-type']),
      resContentType: headerValue(res['content-type']),
      reqBodyRaw: reqBody.text,
      reqBodyTruncated: reqBody.truncated,
      resBodyRaw: resBody.text,
      resBodyTruncated: resBody.truncated,
      requestHeaders: req,
      responseHeaders: res,
      correlation: {
        ...correlationIds(
          (name) => req[name],
          (name) => res[name]
        ),
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
 * Pair undici's freshly built request with the dispatch that built it: the
 * innermost one still inside `dispatch()`, and only if origin, path and method
 * agree (a proxy agent building its CONNECT request does not). A dispatcher
 * that queues the request and builds it later (a pool at its connection limit)
 * publishes outside any dispatch; that call keeps its dispatch-time headers.
 */
function claimRequest(inFlight: PendingDispatch[], message: unknown): void {
  try {
    const current = inFlight[inFlight.length - 1];
    const request = (message as { request?: UndiciRequest } | null)?.request;
    if (!current || current.request || !request) return;
    if (request.path !== current.path) return;
    if (String(request.method).toUpperCase() !== current.method) return;
    if (parseOrigin(request.origin as DispatchOptions['origin'])?.host !== current.host) return;
    current.request = request;
  } catch {
    // A request we cannot read keeps its dispatch-time headers.
  }
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

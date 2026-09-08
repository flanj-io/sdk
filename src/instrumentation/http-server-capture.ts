import type { IncomingMessage, ServerResponse } from 'node:http';
import { InstrumentationBase, type InstrumentationModuleDefinition } from '@opentelemetry/instrumentation';
import { context, trace } from '@opentelemetry/api';
import { SDK_NAME, SDK_VERSION } from '../version';
import { CappedBuffer } from './capped-buffer';
import { CapturedCall } from './captured-call';
import { assembleCapturedCall } from './assemble-call';
import { decodeBody } from './decode-body';
import { classifyHost, type EdgeClass } from './classify-host';
import { DEFAULT_BODY_CAP_BYTES, HttpBodyCaptureConfig, isIgnoredUrl } from './config';
import { resolveIngressPeer } from './resolve-ingress-peer';
import { TrustedProxies } from './trusted-proxies';
import { builtinModule } from './builtin-module';

interface ServerCtor {
  prototype: Record<string, unknown> & { emit?: unknown };
}

type HeaderValue = string | string[] | number | undefined;

/**
 * Custom OTel instrumentation for the INGRESS (server) path: incoming http/https
 * requests the org SERVES. Symmetric to the client path — it patches
 * `Server.prototype.emit` on core `http`/`https`, intercepts the `'request'`
 * event, and for each handled request emits a `direction="server"` record.
 *
 * The CALLER (source) host is classified: **external** callers get body capture
 * (request body teed WITHOUT consuming the stream + response body teed) with
 * redaction at source; **internal** callers are metadata-only — bodies are NEVER
 * teed, so no raw internal body can exist.
 *
 * The caller is the SOCKET PEER. `X-Forwarded-For` is believed only when that
 * peer is a configured trusted proxy (`trustedProxies`), and then the caller is
 * the hop the proxy appended, not the leftmost one — see `resolveIngressPeer`.
 * Unconfigured, the header is ignored: it is client-controlled, and honouring it
 * let any caller pick its own edge class and so whether its bodies were captured.
 *
 * Everything is wrapped defensively: a capture failure is swallowed and the
 * app's own request handling (which still reads the full, unmodified body) is
 * never disturbed.
 */
export class HttpServerCaptureInstrumentation extends InstrumentationBase<HttpBodyCaptureConfig> {
  /**
   * `config.trustedProxies`, parsed once per config. The base constructor
   * routes through `setConfig`, so this is populated before any request can be
   * seen (`declare`: no field initializer may reset it after `super()`).
   */
  declare private trusted: TrustedProxies;

  constructor(config: HttpBodyCaptureConfig) {
    super(`${SDK_NAME}/instrumentation-http-server-capture`, SDK_VERSION, config);
  }

  override setConfig(config: HttpBodyCaptureConfig): void {
    // Parse — and validate — HERE, so an unparseable entry fails at start(),
    // never inside a request where the swallow-everything guard would hide it.
    this.trusted = new TrustedProxies(config.trustedProxies);
    super.setConfig(config);
  }

  protected init(): InstrumentationModuleDefinition[] {
    return [];
  }

  // A prototype method: every Server instance — including one built through an
  // ESM `import { createServer }` binding taken before start() — looks `emit` up
  // at call time, so no ESM facade re-sync is needed here (contrast the
  // `request`/`get` EXPORTS the client path patches in http-body-capture.ts).
  override enable(): void {
    this.patchServer(builtinModule('node:http'));
    this.patchServer(builtinModule('node:https'));
  }

  override disable(): void {
    for (const mod of [builtinModule('node:http'), builtinModule('node:https')]) {
      const Server = mod.Server as ServerCtor | undefined;
      if (Server?.prototype && typeof Server.prototype.emit === 'function') {
        this._unwrap(Server.prototype, 'emit');
      }
    }
  }

  private patchServer(mod: Record<string, unknown>): void {
    const Server = mod.Server as ServerCtor | undefined;
    if (Server?.prototype && typeof Server.prototype.emit === 'function') {
      this._wrap(Server.prototype, 'emit', this.makeEmitPatch());
    }
  }

  private makeEmitPatch() {
    const self = this;
    return (original: unknown) => {
      const originalFn = original as (this: unknown, event: string, ...args: unknown[]) => boolean;
      return function patched(this: unknown, event: string, ...args: unknown[]): boolean {
        if (event === 'request') {
          try {
            self.instrumentRequest(args[0] as IncomingMessage, args[1] as ServerResponse);
          } catch {
            // Instrumentation must never break the app's request handling.
          }
        }
        return originalFn.apply(this, [event, ...args]);
      };
    };
  }

  private instrumentRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!req || !res) return;
    const cfg = this.getConfig();
    const cap = cfg.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;

    const encrypted = Boolean((req.socket as unknown as { encrypted?: boolean } | undefined)?.encrypted);
    const protocol = encrypted ? 'https:' : 'http:';
    const host = headerValue(req.headers.host) ?? '';
    const path = req.url ?? '/';

    if (isIgnoredUrl(`${protocol}//${host}${path}`, cfg.ignoreUrls)) return;

    // Classify the CALLER/source: the socket peer — or, when that peer is a
    // trusted proxy, the hop the proxy appended to X-Forwarded-For.
    const peerHost = resolveIngressPeer({
      socketAddress: (req.socket as unknown as { remoteAddress?: string } | undefined)?.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
      trustedProxies: this.trusted
    });
    const edgeClass: EdgeClass = classifyHost(peerHost);
    const captureBodies = edgeClass === 'external';

    const startTime = Date.now();
    const spanCtx = trace.getSpanContext(context.active());

    // Tee the INCOMING request body by wrapping the IncomingMessage's internal
    // `push` — never a passive flowing-mode `on('data')` listener, which would
    // starve an app reading the body with `for await`. Only for external callers.
    const reqBuf = new CappedBuffer(cap);
    if (captureBodies) {
      const originalPush = req.push.bind(req);
      (req as unknown as { push: IncomingMessage['push'] }).push = (chunk: unknown, encoding?: BufferEncoding) => {
        if (chunk !== null && chunk !== undefined) safeAppend(reqBuf, chunk, encoding);
        return originalPush(chunk as never, encoding as never);
      };
    }

    // Tee the OUTGOING response body by wrapping write/end.
    const resBuf = new CappedBuffer(cap);
    if (captureBodies) {
      this.wrapWriter(res, 'write', resBuf);
      this.wrapWriter(res, 'end', resBuf);
    }

    // Response headers are recorded for EVERY edge (internal rows carry headers
    // too, just no body), so writeHead is wrapped unconditionally. It records
    // headers only — it never touches the body, so the internal-edge invariant
    // "no bytes are ever teed" is untouched.
    const writeHeadHeaders: Record<string, HeaderValue> = {};
    this.wrapWriteHead(res, writeHeadHeaders);

    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      try {
        const call = this.buildCall({
          req,
          res,
          protocol,
          host,
          path,
          peerHost,
          edgeClass,
          captureBodies,
          reqBuf,
          resBuf,
          writeHeadHeaders,
          startTime,
          spanCtx
        });
        cfg.onCapture?.(call);
      } catch {
        // swallow — never surface capture errors to the app
      }
    };
    res.on('finish', finalize);
    res.on('close', finalize);
  }

  private wrapWriter(res: ServerResponse, name: 'write' | 'end', buf: CappedBuffer): void {
    const original = res[name].bind(res) as (...a: unknown[]) => unknown;
    (res as unknown as Record<string, unknown>)[name] = (...callArgs: unknown[]): unknown => {
      const chunk = callArgs[0];
      const encoding = typeof callArgs[1] === 'string' ? (callArgs[1] as BufferEncoding) : undefined;
      if (chunk && typeof chunk !== 'function') buf.append(chunk, encoding);
      return original(...callArgs);
    };
  }

  /**
   * Record the headers handed to `res.writeHead(...)`.
   *
   * Node's `writeHead` fast path passes its headers argument straight to the
   * serializer and never populates the outgoing-header map when `setHeader` was
   * not called first — so `res.getHeaders()` and `res.getHeader('content-type')`
   * both come back EMPTY for an app that replies that way. Fastify does exactly
   * `res.writeHead(statusCode, reply[kReplyHeaders])`, so without this every
   * Fastify provider yields request-only ingress rows: the content-type gate
   * sees nothing and discards response bytes that were already teed.
   */
  private wrapWriteHead(res: ServerResponse, sink: Record<string, HeaderValue>): void {
    const original = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
    (res as unknown as Record<string, unknown>).writeHead = (...callArgs: unknown[]): ServerResponse => {
      try {
        collectWriteHeadHeaders(callArgs, sink);
      } catch {
        // Instrumentation must never break the app's response path.
      }
      return original(...callArgs);
    };
  }

  private buildCall(input: {
    req: IncomingMessage;
    res: ServerResponse;
    protocol: string;
    host: string;
    path: string;
    peerHost: string;
    edgeClass: EdgeClass;
    captureBodies: boolean;
    reqBuf: CappedBuffer;
    resBuf: CappedBuffer;
    writeHeadHeaders: Record<string, HeaderValue>;
    startTime: number;
    spanCtx: ReturnType<typeof trace.getSpanContext>;
  }): CapturedCall {
    const cfg = this.getConfig();
    const cap = cfg.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    const { req, res, reqBuf, resBuf, startTime } = input;

    // `res.getHeaders()` is authoritative when the app used setHeader, and EMPTY
    // when it replied via writeHead alone — so the recorded writeHead headers are
    // the floor and getHeaders() wins wherever both carry a key.
    const responseHeaders: Record<string, HeaderValue> = {
      ...input.writeHeadHeaders,
      ...(res.getHeaders() as Record<string, HeaderValue>)
    };

    const reqContentType = headerValue(req.headers['content-type']);
    const resContentType = headerValue(responseHeaders['content-type']);

    // Undo any `content-encoding` before the redactor sees the payload: an app
    // behind compression middleware writes plaintext, but the bytes reaching our
    // `write`/`end` tee are already compressed. A coding we cannot undo yields NO
    // body rather than an unscanned blob reported as clean.
    const reqBody = decodeBody(reqBuf.toBuffer(), headerValue(req.headers['content-encoding']), cap, reqBuf.truncated);
    const resBody = decodeBody(resBuf.toBuffer(), headerValue(responseHeaders['content-encoding']), cap, resBuf.truncated);

    // The caller's socket address — kept alongside peerHost even when a
    // trusted proxy's forwarded header supplied the identity (then it is the
    // proxy's address; still useful transport detail).
    const peerAddr = (req.socket as unknown as { remoteAddress?: string } | undefined)?.remoteAddress;

    return assembleCapturedCall({
      integration: cfg.integration,
      direction: 'server',
      peerHost: input.peerHost,
      peerAddr,
      edgeClass: input.edgeClass,
      captureBodies: input.captureBodies,
      method: (req.method ?? 'GET').toUpperCase(),
      protocol: input.protocol,
      host: input.host,
      path: input.path,
      statusCode: res.statusCode ?? 0,
      reqContentType,
      resContentType,
      reqBodyRaw: reqBody.text,
      reqBodyTruncated: reqBody.truncated,
      resBodyRaw: resBody.text,
      resBodyTruncated: resBody.truncated,
      requestHeaders: req.headers as Record<string, string | string[] | undefined>,
      responseHeaders,
      correlation: {
        requestId: pickHeader(req.headers, 'x-request-id') ?? pickHeader(req.headers, 'x-correlation-id'),
        idempotencyKey: pickHeader(req.headers, 'idempotency-key'),
        traceId: input.spanCtx?.traceId,
        spanId: input.spanCtx?.spanId
      },
      durationMs: Date.now() - startTime,
      captureContentTypes: cfg.captureContentTypes,
      headerAllowlist: cfg.headerAllowlist
    });
  }
}

/**
 * Fold the headers argument of `writeHead(code[, statusMessage][, headers])`
 * into `sink`, lowercasing keys. Node accepts an object, a flat
 * `[k, v, k, v, …]` array, and an array of `[k, v]` pairs.
 */
function collectWriteHeadHeaders(args: unknown[], sink: Record<string, HeaderValue>): void {
  const headers = typeof args[1] === 'string' ? args[2] : args[1];
  if (!headers || typeof headers !== 'object') return;
  if (Array.isArray(headers)) {
    if (headers.every((entry) => Array.isArray(entry))) {
      for (const pair of headers as unknown[][]) {
        if (pair.length >= 2) recordHeader(sink, pair[0], pair[1]);
      }
      return;
    }
    for (let i = 0; i + 1 < headers.length; i += 2) recordHeader(sink, headers[i], headers[i + 1]);
    return;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) recordHeader(sink, key, value);
}

function recordHeader(sink: Record<string, HeaderValue>, key: unknown, value: unknown): void {
  if (typeof key !== 'string' || value === undefined || value === null) return;
  if (Array.isArray(value)) sink[key.toLowerCase()] = value.map((v) => String(v));
  else if (typeof value === 'number') sink[key.toLowerCase()] = value;
  else sink[key.toLowerCase()] = String(value);
}

function safeAppend(buf: CappedBuffer, chunk: unknown, encoding?: BufferEncoding): void {
  try {
    buf.append(chunk, encoding);
  } catch {
    // ignore malformed chunk
  }
}

function headerValue(v: string | number | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function pickHeader(headers: IncomingMessage['headers'], key: string): string | undefined {
  const v = headers[key];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

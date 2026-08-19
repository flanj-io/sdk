import type { IncomingMessage, ServerResponse } from 'node:http';
import { InstrumentationBase, type InstrumentationModuleDefinition } from '@opentelemetry/instrumentation';
import { context, trace } from '@opentelemetry/api';
import { SDK_NAME, SDK_VERSION } from '../version';
import { CappedBuffer } from './capped-buffer';
import { CapturedCall } from './captured-call';
import { assembleCapturedCall } from './assemble-call';
import { classifyHost, type EdgeClass } from './classify-host';
import { DEFAULT_BODY_CAP_BYTES, HttpBodyCaptureConfig, isIgnoredUrl } from './config';

/** LIVE, mutable exports of a core module (see http-body-capture.ts for the why). */
function builtin(id: 'node:http' | 'node:https'): Record<string, unknown> {
  const get = (process as unknown as { getBuiltinModule(id: string): Record<string, unknown> }).getBuiltinModule;
  return get.call(process, id);
}

interface ServerCtor {
  prototype: Record<string, unknown> & { emit?: unknown };
}

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
 * Everything is wrapped defensively: a capture failure is swallowed and the
 * app's own request handling (which still reads the full, unmodified body) is
 * never disturbed.
 */
export class HttpServerCaptureInstrumentation extends InstrumentationBase<HttpBodyCaptureConfig> {
  constructor(config: HttpBodyCaptureConfig) {
    super(`${SDK_NAME}/instrumentation-http-server-capture`, SDK_VERSION, config);
  }

  protected init(): InstrumentationModuleDefinition[] {
    return [];
  }

  override enable(): void {
    this.patchServer(builtin('node:http'));
    this.patchServer(builtin('node:https'));
  }

  override disable(): void {
    for (const mod of [builtin('node:http'), builtin('node:https')]) {
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

    // Classify the CALLER/source: X-Forwarded-For first hop, else the socket peer.
    const peerHost =
      firstForwardedHop(req.headers['x-forwarded-for']) ??
      (req.socket as unknown as { remoteAddress?: string } | undefined)?.remoteAddress ??
      '';
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

    let finalized = false;
    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      try {
        const call = this.buildCall({ req, res, protocol, host, path, peerHost, edgeClass, captureBodies, reqBuf, resBuf, startTime, spanCtx });
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
    startTime: number;
    spanCtx: ReturnType<typeof trace.getSpanContext>;
  }): CapturedCall {
    const cfg = this.getConfig();
    const { req, res, reqBuf, resBuf, startTime } = input;

    const reqContentType = headerValue(req.headers['content-type']);
    const resContentType = headerValue(res.getHeader('content-type'));

    return assembleCapturedCall({
      integration: cfg.integration,
      direction: 'server',
      peerHost: input.peerHost,
      edgeClass: input.edgeClass,
      captureBodies: input.captureBodies,
      method: (req.method ?? 'GET').toUpperCase(),
      protocol: input.protocol,
      host: input.host,
      path: input.path,
      statusCode: res.statusCode ?? 0,
      reqContentType,
      resContentType,
      reqBodyRaw: reqBuf.toString(),
      reqBodyTruncated: reqBuf.truncated,
      resBodyRaw: resBuf.toString(),
      resBodyTruncated: resBuf.truncated,
      requestHeaders: req.headers as Record<string, string | string[] | undefined>,
      responseHeaders: res.getHeaders() as Record<string, string | string[] | number | undefined>,
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

/** First hop of an `X-Forwarded-For` chain — the original client. */
function firstForwardedHop(xff: string | string[] | undefined): string | undefined {
  if (xff === undefined) return undefined;
  const v = Array.isArray(xff) ? xff[0] : xff;
  if (!v) return undefined;
  const first = v.split(',')[0]?.trim();
  return first ? first : undefined;
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

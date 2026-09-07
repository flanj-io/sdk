import type { ClientRequest, IncomingMessage } from 'node:http';
import { InstrumentationBase, type InstrumentationModuleDefinition } from '@opentelemetry/instrumentation';
import { context, trace } from '@opentelemetry/api';
import { SDK_NAME, SDK_VERSION } from '../version';
import { CappedBuffer } from './capped-buffer';
import { parseRequestArgs } from './http-args';
import { CapturedCall } from './captured-call';
import { assembleCapturedCall } from './assemble-call';
import { decodeBody } from './decode-body';
import { classifyHost, type EdgeClass } from './classify-host';
import { DEFAULT_BODY_CAP_BYTES, HttpBodyCaptureConfig, isIgnoredUrl } from './config';
import { syncBuiltinEsmExports } from './sync-builtin-esm-exports';

/**
 * Return the LIVE, mutable exports of a core module. `import * as http` under an
 * ESM/esbuild transform yields a read-only namespace whose `request` property is
 * non-configurable — shimmer's defineProperty then fails. `process.getBuiltinModule`
 * (Node 22.3+) returns the real singleton exports object, which is patchable.
 *
 * Patching it reaches every property-at-call-time caller; an ESM named import or
 * namespace taken before `enable()` additionally needs the facade re-sync that
 * `enable()`/`disable()` perform (see `sync-builtin-esm-exports.ts`).
 */
function builtin(id: 'node:http' | 'node:https'): Record<string, unknown> {
  const get = (process as unknown as { getBuiltinModule(id: string): Record<string, unknown> }).getBuiltinModule;
  return get.call(process, id);
}

/**
 * Custom OTel instrumentation that tees the request + response bodies of
 * outgoing http/https CLIENT calls, redacts the (capped) buffer AT SOURCE, drops
 * the raw buffer, and hands a fully-redacted {@link CapturedCall} to `onCapture`.
 *
 * The destination host is classified (external | internal): **external** edges
 * get full body capture (as today); **internal** edges are metadata-only — their
 * bodies are NEVER teed, so no raw internal body can exist to leak.
 *
 * The tee is transparent: request bodies are observed by wrapping `write`/`end`;
 * response bodies by wrapping the IncomingMessage's internal `push`, so a
 * consumer reading the stream with `for await` (async iterator) is never starved
 * — no passive flowing-mode `on('data')` listener is added.
 */
export class HttpBodyCaptureInstrumentation extends InstrumentationBase<HttpBodyCaptureConfig> {
  constructor(config: HttpBodyCaptureConfig) {
    super(`${SDK_NAME}/instrumentation-http-body-capture`, SDK_VERSION, config);
  }

  // We patch the (already-loaded) core http/https modules directly in enable()
  // rather than via require-in-the-middle, which does not re-fire for core
  // modules loaded before the instrumentation is registered — and the ESM
  // counterpart (import-in-the-middle) only works behind a loader hook that
  // was registered before any user module, i.e. it needs the preload anyway.
  protected init(): InstrumentationModuleDefinition[] {
    return [];
  }

  override enable(): void {
    this.patchModule(builtin('node:http'), 'http:');
    this.patchModule(builtin('node:https'), 'https:');
    // Push the patched `request`/`get` into the ESM facades too, so a module
    // that did `import { request } from 'node:http'` BEFORE start() sees them.
    syncBuiltinEsmExports();
  }

  override disable(): void {
    for (const mod of [builtin('node:http'), builtin('node:https')]) {
      for (const name of ['request', 'get'] as const) {
        if (typeof mod[name] === 'function') this._unwrap(mod, name);
      }
    }
    // ...and hand the originals back to those same ESM bindings.
    syncBuiltinEsmExports();
  }

  private patchModule(mod: Record<string, unknown>, protocol: string): void {
    for (const name of ['request', 'get'] as const) {
      if (typeof mod[name] === 'function') {
        this._wrap(mod, name, this.makeRequestPatch(protocol));
      }
    }
  }

  private makeRequestPatch(protocol: string) {
    const self = this;
    return (original: unknown) => {
      const originalFn = original as (...args: unknown[]) => ClientRequest;
      return function patched(this: unknown, ...args: unknown[]): ClientRequest {
        const req = originalFn.apply(this, args);
        try {
          self.instrumentRequest(req, args, protocol);
        } catch {
          // Instrumentation must never break the app's request path.
        }
        return req;
      };
    };
  }

  private instrumentRequest(req: ClientRequest, args: unknown[], protocol: string): void {
    const cfg = this.getConfig();
    const cap = cfg.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    const info = parseRequestArgs(args, protocol);

    // Never capture the SDK's own OTLP export POSTs (or other ignored destinations):
    // capturing them would feed the collector, which the SDK would re-capture, ad infinitum.
    if (isIgnoredUrl(`${info.protocol}//${info.host}${info.path}`, cfg.ignoreUrls)) return;

    // Classify the DESTINATION. Internal edges are metadata-only: we never tee a
    // body, so no raw internal body can be captured (the redaction floor invariant).
    const edgeClass = classifyHost(info.host);
    const captureBodies = edgeClass === 'external';

    const startTime = Date.now();
    const spanCtx = trace.getSpanContext(context.active());

    const reqBuf = new CappedBuffer(cap);
    if (captureBodies) {
      this.wrapWriter(req, 'write', reqBuf);
      this.wrapWriter(req, 'end', reqBuf);
    }

    req.on('response', (res: IncomingMessage) => {
      const resBuf = new CappedBuffer(cap);
      let finalized = false;

      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        try {
          const call = this.buildCall({ req, res, info, reqBuf, resBuf, startTime, spanCtx, edgeClass, captureBodies });
          cfg.onCapture?.(call);
        } catch {
          // swallow — never surface capture errors to the app
        }
      };

      if (captureBodies) {
        const originalPush = res.push.bind(res);
        (res as unknown as { push: IncomingMessage['push'] }).push = (chunk: unknown, encoding?: BufferEncoding) => {
          if (chunk === null || chunk === undefined) {
            finalize();
          } else {
            safeAppend(resBuf, chunk, encoding);
          }
          return originalPush(chunk as never, encoding as never);
        };
      }
      res.on('end', finalize);
    });
  }

  private wrapWriter(req: ClientRequest, name: 'write' | 'end', buf: CappedBuffer): void {
    const original = req[name].bind(req) as (...a: unknown[]) => unknown;
    (req as unknown as Record<string, unknown>)[name] = (...callArgs: unknown[]): unknown => {
      const chunk = callArgs[0];
      const encoding = typeof callArgs[1] === 'string' ? (callArgs[1] as BufferEncoding) : undefined;
      if (chunk && typeof chunk !== 'function') buf.append(chunk, encoding);
      return original(...callArgs);
    };
  }

  private buildCall(input: {
    req: ClientRequest;
    res: IncomingMessage;
    info: ReturnType<typeof parseRequestArgs>;
    reqBuf: CappedBuffer;
    resBuf: CappedBuffer;
    startTime: number;
    spanCtx: ReturnType<typeof trace.getSpanContext>;
    edgeClass: EdgeClass;
    captureBodies: boolean;
  }): CapturedCall {
    const cfg = this.getConfig();
    const cap = cfg.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;
    const { req, res, info, reqBuf, resBuf, startTime, edgeClass, captureBodies } = input;

    const reqContentType = headerValue(req.getHeader('content-type'));
    const resContentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined;

    // Undo any `content-encoding` BEFORE the redactor sees the payload. Node's
    // IncomingMessage hands us the raw wire bytes — every client library that
    // sends `Accept-Encoding` inflates downstream, in userland — so without this
    // a gzip'd JSON response would be stored as mangled bytes, unscanned, and
    // reported `redaction.applied=false`. A coding we cannot undo yields NO body.
    const reqBody = decodeBody(reqBuf.toBuffer(), headerValue(req.getHeader('content-encoding')), cap, reqBuf.truncated);
    const resBody = decodeBody(resBuf.toBuffer(), pickHeader(res.headers, 'content-encoding'), cap, resBuf.truncated);

    // The resolved remote IP the connection actually went to — transport
    // detail alongside the peer.host identity (the name the app dialed).
    const peerAddr = (res.socket as unknown as { remoteAddress?: string } | undefined)?.remoteAddress;

    return assembleCapturedCall({
      integration: cfg.integration,
      direction: 'client',
      peerHost: info.host,
      peerAddr,
      edgeClass,
      captureBodies,
      method: info.method,
      protocol: info.protocol,
      host: info.host,
      path: info.path,
      statusCode: res.statusCode ?? 0,
      reqContentType,
      resContentType,
      reqBodyRaw: reqBody.text,
      reqBodyTruncated: reqBody.truncated,
      resBodyRaw: resBody.text,
      resBodyTruncated: resBody.truncated,
      requestHeaders: outgoingHeaders(req),
      responseHeaders: res.headers as Record<string, string | string[] | undefined>,
      correlation: {
        requestId:
          pickHeader(res.headers, 'x-request-id') ??
          pickHeader(res.headers, 'x-correlation-id') ??
          headerValue(req.getHeader('x-request-id')) ??
          headerValue(req.getHeader('x-correlation-id')),
        idempotencyKey: headerValue(req.getHeader('idempotency-key')) ?? pickHeader(res.headers, 'idempotency-key'),
        traceId: input.spanCtx?.traceId,
        spanId: input.spanCtx?.spanId
      },
      durationMs: Date.now() - startTime,
      captureContentTypes: cfg.captureContentTypes,
      headerAllowlist: cfg.headerAllowlist
    });
  }
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

function outgoingHeaders(req: ClientRequest): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  const names = typeof req.getHeaderNames === 'function' ? req.getHeaderNames() : [];
  for (const name of names) {
    const v = req.getHeader(name);
    out[name] = typeof v === 'number' ? String(v) : (v as string | string[] | undefined);
  }
  return out;
}

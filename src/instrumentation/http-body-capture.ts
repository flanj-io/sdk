import type { ClientRequest, IncomingMessage } from 'node:http';
import { InstrumentationBase, type InstrumentationModuleDefinition } from '@opentelemetry/instrumentation';
import { context, trace } from '@opentelemetry/api';
import { redactDetailed, redactHeaders, DEFAULT_HEADER_ALLOWLIST, type PatternId } from '@vinifera/redaction-patterns';
import { SDK_NAME, SDK_VERSION } from '../version';
import { CappedBuffer } from './capped-buffer';
import { parseRequestArgs } from './http-args';
import { CapturedCall } from './captured-call';
import {
  DEFAULT_BODY_CAP_BYTES,
  DEFAULT_CAPTURE_CONTENT_TYPES,
  HttpBodyCaptureConfig,
  isCaptureableContentType
} from './config';

const REPORT_ORDER: readonly PatternId[] = ['PAN', 'EMAIL', 'IBAN', 'SSN', 'PHONE', 'CVV', 'TOKEN', 'IP'];

/**
 * Return the LIVE, mutable exports of a core module. `import * as http` under an
 * ESM/esbuild transform yields a read-only namespace whose `request` property is
 * non-configurable — shimmer's defineProperty then fails. `process.getBuiltinModule`
 * (Node 22.3+) returns the real singleton exports object, which is patchable.
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
  // modules loaded before the instrumentation is registered.
  protected init(): InstrumentationModuleDefinition[] {
    return [];
  }

  override enable(): void {
    this.patchModule(builtin('node:http'), 'http:');
    this.patchModule(builtin('node:https'), 'https:');
  }

  override disable(): void {
    for (const mod of [builtin('node:http'), builtin('node:https')]) {
      for (const name of ['request', 'get'] as const) {
        if (typeof mod[name] === 'function') this._unwrap(mod, name);
      }
    }
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
    const startTime = Date.now();

    const spanCtx = trace.getSpanContext(context.active());

    const reqBuf = new CappedBuffer(cap);
    this.wrapWriter(req, 'write', reqBuf);
    this.wrapWriter(req, 'end', reqBuf);

    req.on('response', (res: IncomingMessage) => {
      const resBuf = new CappedBuffer(cap);
      let finalized = false;

      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        try {
          const call = this.buildCall({ req, res, info, reqBuf, resBuf, startTime, spanCtx, cap });
          cfg.onCapture?.(call);
        } catch {
          // swallow — never surface capture errors to the app
        }
      };

      const originalPush = res.push.bind(res);
      (res as unknown as { push: IncomingMessage['push'] }).push = (chunk: unknown, encoding?: BufferEncoding) => {
        if (chunk === null || chunk === undefined) {
          finalize();
        } else {
          reqBufSafeAppend(resBuf, chunk, encoding);
        }
        return originalPush(chunk as never, encoding as never);
      };
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
    cap: number;
  }): CapturedCall {
    const cfg = this.getConfig();
    const allowlist = cfg.headerAllowlist ?? DEFAULT_HEADER_ALLOWLIST;
    const contentTypes = cfg.captureContentTypes ?? DEFAULT_CAPTURE_CONTENT_TYPES;
    const { req, res, info, reqBuf, resBuf, startTime } = input;

    const reqContentType = headerValue(req.getHeader('content-type'));
    const resContentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined;

    const firedPatterns = new Set<PatternId>();

    // Redact bodies AT SOURCE. If the content-type is not captureable, we keep
    // NO body at all (the raw bytes are never emitted). The capped raw buffers
    // go out of scope immediately after this function returns.
    const reqRedaction = isCaptureableContentType(reqContentType, contentTypes)
      ? redactDetailed(reqBuf.toString())
      : { text: '', patterns: [] as PatternId[] };
    const resRedaction = isCaptureableContentType(resContentType, contentTypes)
      ? redactDetailed(resBuf.toString())
      : { text: '', patterns: [] as PatternId[] };

    const targetRedaction = redactDetailed(info.path);
    const urlRedaction = redactDetailed(`${info.protocol}//${info.host}${info.path}`);
    for (const p of [...reqRedaction.patterns, ...resRedaction.patterns, ...targetRedaction.patterns, ...urlRedaction.patterns]) {
      firedPatterns.add(p);
    }

    const requestHeaders = redactHeaders(outgoingHeaders(req), allowlist);
    const responseHeaders = redactHeaders(res.headers as Record<string, string | string[] | undefined>, allowlist);

    const correlation = {
      requestId: pickHeader(res.headers, 'x-request-id') ?? pickHeader(res.headers, 'x-correlation-id') ?? headerValue(req.getHeader('x-request-id')) ?? headerValue(req.getHeader('x-correlation-id')),
      idempotencyKey: headerValue(req.getHeader('idempotency-key')) ?? pickHeader(res.headers, 'idempotency-key'),
      traceId: input.spanCtx?.traceId,
      spanId: input.spanCtx?.spanId
    };

    const patterns = REPORT_ORDER.filter((id) => firedPatterns.has(id));

    return {
      integration: cfg.integration,
      direction: 'client',
      method: info.method,
      route: targetRedaction.text,
      target: targetRedaction.text,
      urlFull: urlRedaction.text,
      statusCode: res.statusCode ?? 0,
      requestContentType: reqContentType,
      requestBody: reqRedaction.text,
      requestBodyTruncated: reqBuf.truncated,
      requestHeaders,
      responseContentType: resContentType,
      responseBody: resRedaction.text,
      responseBodyTruncated: resBuf.truncated,
      responseHeaders,
      correlation,
      durationMs: Date.now() - startTime,
      redactionApplied: patterns.length > 0,
      redactionPatterns: patterns,
      redactionSpecAware: false
    };
  }
}

function reqBufSafeAppend(buf: CappedBuffer, chunk: unknown, encoding?: BufferEncoding): void {
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

import { normalizeUndiciHeaders } from './undici-headers';
import type { DispatchHandler } from './undici-types';

type Method = (...args: unknown[]) => unknown;
type Handler = Record<string, unknown>;

/**
 * The controller a new-API handler is given, driven from legacy callbacks: it
 * records pause/resume/abort so the legacy side can answer undici the way it
 * expects (`onHeaders`/`onData` return `false` to pause; `resume` restarts).
 */
class LegacyDrivenController {
  private pausedFlag = false;
  private abortedFlag = false;
  private abortReason: unknown = null;
  resumeFn: (() => void) | null = null;
  rawHeaders: unknown[] | null = null;
  rawTrailers: unknown[] | null = null;

  constructor(private readonly abortFn: (reason: unknown) => void) {}

  pause(): void {
    this.pausedFlag = true;
  }

  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    this.resumeFn?.();
  }

  abort(reason?: unknown): void {
    if (this.abortedFlag) return;
    this.abortedFlag = true;
    this.abortReason = reason;
    this.abortFn(reason);
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  get aborted(): boolean {
    return this.abortedFlag;
  }

  get reason(): unknown {
    return this.abortReason;
  }
}

/**
 * Present a dispatch handler to a dispatcher that only understands undici 6's
 * legacy callbacks. A handler that already speaks legacy (no `onRequestStart`)
 * is returned as is. A new-API handler — what undici ≥ 7 hands a global
 * dispatcher, and the only API undici 8 speaks — is driven through a controller:
 *
 *   onConnect(abort)            → onRequestStart(controller, context)
 *   onHeaders(status, raw, …)   → onResponseStart(controller, status, headers, text); `!paused`
 *   onData(chunk)               → onResponseData(controller, chunk); `!paused`
 *   onComplete(rawTrailers)     → onResponseEnd(controller, trailers)
 *   onError(err)                → onResponseError(controller, err)
 *   onUpgrade(status, raw, s)   → onRequestUpgrade(controller, status, headers, s)
 *
 * This is the conversion undici 7's own dispatchers apply internally; it exists
 * here because Node 20–23 bundle undici 6, whose dispatchers predate it.
 */
export function toLegacyHandler(handler: DispatchHandler): DispatchHandler {
  const h = handler as Handler;
  if (typeof h.onRequestStart !== 'function') return handler;
  const call = (name: string, ...args: unknown[]): unknown =>
    typeof h[name] === 'function' ? (h[name] as Method).apply(h, args) : undefined;
  let controller = new LegacyDrivenController(() => undefined);

  const legacy: Handler = {
    onConnect(abort: (reason: unknown) => void, context?: unknown): void {
      controller = new LegacyDrivenController(abort);
      call('onRequestStart', controller, context);
    },
    onResponseStarted(): unknown {
      return call('onResponseStarted');
    },
    onHeaders(statusCode: number, rawHeaders: unknown[], resume: () => void, statusText?: string): boolean {
      controller.resumeFn = resume;
      controller.rawHeaders = rawHeaders;
      call('onResponseStart', controller, statusCode, normalizeUndiciHeaders(rawHeaders), statusText);
      return !controller.paused;
    },
    onData(chunk: unknown): boolean {
      call('onResponseData', controller, chunk);
      return !controller.paused;
    },
    onComplete(rawTrailers: unknown[] | null): void {
      controller.rawTrailers = rawTrailers ?? [];
      call('onResponseEnd', controller, normalizeUndiciHeaders(rawTrailers ?? []));
    },
    onError(err: unknown): void {
      if (typeof h.onResponseError !== 'function') throw err;
      call('onResponseError', controller, err);
    },
    onUpgrade(statusCode: number, rawHeaders: unknown[], socket: unknown): void {
      controller.rawHeaders = rawHeaders;
      call('onRequestUpgrade', controller, statusCode, normalizeUndiciHeaders(rawHeaders), socket);
    }
  };
  // Optional request-side callbacks some handlers use; forwarded only when present.
  for (const name of ['onBodySent', 'onRequestSent']) {
    if (typeof h[name] === 'function') legacy[name] = (...args: unknown[]) => call(name, ...args);
  }
  return legacy;
}

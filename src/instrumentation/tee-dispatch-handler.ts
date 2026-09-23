import { normalizeUndiciHeaders } from './undici-headers';
import type { DispatchHandler } from './undici-types';

/** What the capture needs to see of one response, whichever handler API delivered it. */
export interface DispatchObserver {
  onResponseStart(statusCode: number, headers: Record<string, string | string[]>): void;
  onResponseData(chunk: unknown): void;
  onResponseEnd(): void;
  /** The call will not complete as an HTTP response: an error, an abort, or a protocol upgrade. */
  onAbandon(): void;
}

type Method = (...args: unknown[]) => unknown;

/**
 * Wrap a dispatch handler so `observer` sees the response as it streams past,
 * while every call — and every return value, which is how a handler applies
 * backpressure (`false` pauses the socket) — still goes to the original.
 *
 * Two handler APIs exist and both are live on the Node lines this SDK supports:
 *
 * - **undici 6** (Node 20.16–23): `onConnect`, `onHeaders(status, rawHeaders,
 *   resume, statusText)`, `onData(chunk)`, `onComplete(trailers)`,
 *   `onError(err)`, `onUpgrade(…)`. Raw headers are a flat Buffer array.
 * - **undici 7** (Node 24): `onRequestStart`, `onResponseStart(controller,
 *   status, headers, statusText)`, `onResponseData(controller, chunk)`,
 *   `onResponseEnd(controller, trailers)`, `onResponseError(controller, err)`,
 *   `onRequestUpgrade(…)`. Headers arrive parsed. Its `compose()` converts every
 *   handler to this API before an interceptor sees it.
 *
 * Which one a handler speaks is decided by FEATURE — does it have
 * `onRequestStart` — exactly as undici itself decides, never by version string.
 * The wrapper then speaks the same API, so undici's adapters treat it the way
 * they treated the original.
 *
 * The wrapper is a Proxy over the original: it overrides only the response
 * callbacks it observes, and hands every other property through bound to the
 * original — a handler that keeps state in private fields (undici 7's own
 * `WrapHandler` does) would throw if called with the Proxy as `this`.
 */
export function teeDispatchHandler<H extends DispatchHandler>(handler: H, observer: DispatchObserver): H {
  const target = handler as unknown as Record<string | symbol, unknown>;
  const has = (name: string): boolean => typeof target[name] === 'function';
  const forward = (name: string, args: unknown[]): unknown => (target[name] as Method).apply(target, args);
  const overrides: Record<string, Method> = {};
  const over = (name: string, see: (args: unknown[]) => void): void => {
    // Only a callback the original HAS is overridden: undici treats a missing
    // one differently from a present one (a missing `onResponseError` throws).
    if (!has(name)) return;
    overrides[name] = (...args: unknown[]): unknown => {
      try {
        see(args);
      } catch {
        // Observation must never change what the original handler receives.
      }
      return forward(name, args);
    };
  };

  if (has('onRequestStart')) {
    over('onResponseStart', ([, status, headers]) =>
      observer.onResponseStart(Number(status), normalizeUndiciHeaders(headers))
    );
    over('onResponseData', ([, chunk]) => observer.onResponseData(chunk));
    over('onResponseEnd', () => observer.onResponseEnd());
    over('onResponseError', () => observer.onAbandon());
    over('onRequestUpgrade', () => observer.onAbandon());
  } else {
    over('onHeaders', ([status, rawHeaders]) =>
      observer.onResponseStart(Number(status), normalizeUndiciHeaders(rawHeaders))
    );
    over('onData', ([chunk]) => observer.onResponseData(chunk));
    over('onComplete', () => observer.onResponseEnd());
    over('onError', () => observer.onAbandon());
    over('onUpgrade', () => observer.onAbandon());
  }

  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
      const value = Reflect.get(t, key, t);
      return typeof value === 'function' ? (value as Method).bind(t) : value;
    }
  }) as unknown as H;
}

/**
 * The slice of undici's dispatcher API the fetch capture touches, typed
 * locally: the SDK never imports `undici` (a userland copy is a different
 * module from the one Node bundles behind global `fetch()`), so these describe
 * the objects Node's own undici hands us at runtime.
 */

/** `Dispatcher.dispatch` options — what `fetch()` builds for every hop it puts on the wire. */
export interface DispatchOptions {
  origin?: string | URL;
  path?: string;
  method?: string;
  body?: unknown;
  headers?: unknown;
  upgrade?: string | null;
  [key: string]: unknown;
}

/** A dispatch handler — undici 6's `onHeaders/onData/…` or undici 7's `onResponseStart/…` shape. */
export type DispatchHandler = object;

export type DispatchFn = (opts: DispatchOptions, handler: DispatchHandler) => unknown;

/** An undici interceptor: takes the next dispatch, returns a dispatch of arity 2. */
export type DispatchInterceptor = (dispatch: DispatchFn) => DispatchFn;

export interface UndiciDispatcher {
  dispatch: DispatchFn;
  /** undici ≥ 6.18 (every Node line this SDK supports bundles one). */
  compose?: (...interceptors: DispatchInterceptor[]) => UndiciDispatcher;
}

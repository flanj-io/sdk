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
type Handler = Record<string, unknown>;

const ORIGINAL = Symbol('original handler');
const OBSERVER = Symbol('observer');

/** The per-dispatch state of a wrapper: two references. Every method lives on a shared prototype. */
class TeeHandler {
  readonly [ORIGINAL]: Handler;
  readonly [OBSERVER]: DispatchObserver;

  constructor(original: Handler, observer: DispatchObserver) {
    this[ORIGINAL] = original;
    this[OBSERVER] = observer;
  }
}

type TeeHandlerClass = new (original: Handler, observer: DispatchObserver) => TeeHandler;

/** One handler API: its callbacks, which of them are observed, and the wrapper classes built so far. */
interface HandlerApi {
  /** Every callback undici may call on a handler of this API. Bit `i` of a shape is `callbacks[i]`. */
  callbacks: readonly string[];
  known: ReadonlySet<string>;
  /** The prototype method for each callback, index-aligned with `callbacks`. */
  methods: readonly Method[];
  /** One wrapper class per shape (which callbacks the original has), built on first sight. */
  classes: Map<number, TeeHandlerClass>;
}

type See = (observer: DispatchObserver, args: unknown[]) => void;

/** A prototype method that hands the call to the ORIGINAL handler, `this` included. */
function forwardTo(name: string): Method {
  return function forward(this: TeeHandler, ...args: unknown[]): unknown {
    const original = this[ORIGINAL];
    return (original[name] as Method).apply(original, args);
  };
}

/** A prototype method that shows the call to the observer first, then forwards it unchanged. */
function observeThen(name: string, see: See): Method {
  const forward = forwardTo(name);
  return function observed(this: TeeHandler, ...args: unknown[]): unknown {
    try {
      see(this[OBSERVER], args);
    } catch {
      // Observation must never change what the original handler receives.
    }
    return forward.apply(this, args);
  };
}

function handlerApi(callbacks: readonly string[], observed: Record<string, See>): HandlerApi {
  return {
    callbacks,
    known: new Set(callbacks),
    methods: callbacks.map((name) => (observed[name] ? observeThen(name, observed[name]) : forwardTo(name))),
    classes: new Map()
  };
}

/** undici 6 (Node 20.16–23): raw headers as a flat Buffer array, and no controller argument. */
const LEGACY = handlerApi(
  ['onConnect', 'onResponseStarted', 'onHeaders', 'onData', 'onComplete', 'onError', 'onUpgrade', 'onBodySent', 'onRequestSent'],
  {
    onHeaders: (o, [status, rawHeaders]) => o.onResponseStart(Number(status), normalizeUndiciHeaders(rawHeaders)),
    onData: (o, [chunk]) => o.onResponseData(chunk),
    onComplete: (o) => o.onResponseEnd(),
    onError: (o) => o.onAbandon(),
    onUpgrade: (o) => o.onAbandon()
  }
);

/** undici ≥ 7 (Node 24): a controller first, then parsed headers. */
const CONTROLLER = handlerApi(
  [
    'onRequestStart',
    'onRequestUpgrade',
    'onResponseStart',
    'onResponseData',
    'onResponseEnd',
    'onResponseError',
    'onResponseStarted',
    'onBodySent',
    'onRequestSent'
  ],
  {
    onResponseStart: (o, [, status, headers]) => o.onResponseStart(Number(status), normalizeUndiciHeaders(headers)),
    onResponseData: (o, [, chunk]) => o.onResponseData(chunk),
    onResponseEnd: (o) => o.onResponseEnd(),
    onResponseError: (o) => o.onAbandon(),
    onRequestUpgrade: (o) => o.onAbandon()
  }
);

function wrapperClass(api: HandlerApi, handler: Handler): TeeHandlerClass {
  let shape = 0;
  let bit = 1;
  for (const name of api.callbacks) {
    if (typeof handler[name] === 'function') shape |= bit;
    bit <<= 1;
  }
  let cls = api.classes.get(shape);
  if (!cls) {
    const proto = (cls = class extends TeeHandler {}).prototype;
    api.callbacks.forEach((name, i) => {
      // Only a callback the original HAS is defined: undici treats a missing
      // one differently from a present one (a missing `onResponseError` throws;
      // `onBodySent` is called only when present).
      if (shape & (1 << i)) defineMethod(proto, name, api.methods[i] as Method);
    });
    api.classes.set(shape, cls);
  }
  return cls;
}

/**
 * Methods of the original that are not a callback of its API — a callback a
 * later undici adds, or the other API's callbacks on a handler that speaks
 * both — so they still reach the original through the wrapper. `for…in` sees
 * own (and enumerable inherited) keys without building an array; class methods
 * are non-enumerable, so a prototype chain is walked once and remembered.
 */
function unknownMethods(api: HandlerApi, handler: Handler): string[] | undefined {
  let found: string[] | undefined;
  for (const key in handler) {
    if (!api.known.has(key) && typeof handler[key] === 'function') (found ??= []).push(key);
  }
  const inherited = prototypeMethods(Object.getPrototypeOf(handler) as object | null);
  for (const key of inherited) {
    if (!api.known.has(key) && !found?.includes(key)) (found ??= []).push(key);
  }
  return found;
}

const protoMethodCache = new WeakMap<object, readonly string[]>();

function prototypeMethods(proto: object | null): readonly string[] {
  if (proto === null || proto === Object.prototype) return [];
  let names = protoMethodCache.get(proto);
  if (!names) {
    const out = new Set<string>();
    for (let p: object | null = proto; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
      for (const name of Object.getOwnPropertyNames(p)) {
        if (name === 'constructor') continue;
        // The descriptor, not a read: a getter on a handler prototype is never invoked.
        if (typeof Object.getOwnPropertyDescriptor(p, name)?.value === 'function') out.add(name);
      }
    }
    names = [...out];
    protoMethodCache.set(proto, names);
  }
  return names;
}

const forwarders = new Map<string, Method>();

function defineMethod(target: object, name: string, method: Method): void {
  Object.defineProperty(target, name, { value: method, writable: true, configurable: true, enumerable: false });
}

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
 * This runs once per dispatch, so the wrapper is one small object: the original
 * and the observer. Its methods live on a prototype shared by every handler of
 * the same API and shape (which callbacks it has), built the first time that
 * shape is seen; nothing is allocated or bound per call. Each method calls the
 * ORIGINAL's method with the original as `this` — a handler that keeps state in
 * private fields (undici 7's own `WrapHandler` does) throws if called with any
 * other receiver.
 */
export function teeDispatchHandler<H extends DispatchHandler>(handler: H, observer: DispatchObserver): H {
  const original = handler as unknown as Handler;
  const api = typeof original.onRequestStart === 'function' ? CONTROLLER : LEGACY;
  const Wrapper = wrapperClass(api, original);
  const wrapper = new Wrapper(original, observer);
  const extra = unknownMethods(api, original);
  if (extra) {
    for (const name of extra) {
      let forward = forwarders.get(name);
      if (!forward) forwarders.set(name, (forward = forwardTo(name)));
      defineMethod(wrapper, name, forward);
    }
  }
  return wrapper as unknown as H;
}

import { composeDispatcher } from './compose-dispatcher';
import { toLegacyHandler } from './to-legacy-handler';
import type { DispatchInterceptor, DispatchOptions, DispatchHandler, UndiciDispatcher } from './undici-types';

/**
 * undici keeps the process-wide dispatcher on `globalThis` under registered
 * symbols, which is how every copy of undici in a process — the one Node
 * bundles behind global `fetch()` and any userland one — agrees on it:
 *
 * - `.1` — read by undici 6 and 7, so by Node's `fetch()` on every supported line.
 *   It carries LEGACY-API handlers (`onConnect/onHeaders/onData/…`) from undici 6.
 * - `.2` — written by undici 7 (the same dispatcher as `.1`) and 8, READ by
 *   undici 8, whose handlers speak only the new API (`onRequestStart/…`). undici 8
 *   keeps a legacy-wrapped copy of its own dispatcher in `.1`.
 *
 * An undici that finds its slot empty at load installs a fresh Agent in BOTH
 * slots — so a userland undici 8 loaded after `start()` on a Node that bundles
 * undici 6 (20.16–23.x, where `.2` is empty) would overwrite the capture layer
 * in `.1`, silently. {@link undiciGlobalDispatcher.install} therefore always
 * leaves `.2` occupied, and never with something that cannot take its handlers.
 */
const V1 = Symbol.for('undici.globalDispatcher.1');
const V2 = Symbol.for('undici.globalDispatcher.2');

type Slots = Record<symbol, UndiciDispatcher | undefined>;
const slots = globalThis as unknown as Slots;

/**
 * Every bridge (and every view composed from one) dispatches into `.1`. A layer
 * composed onto one would capture a call twice — once there, once in `.1` — so
 * `install` leaves a bridge in `.2` alone. Keyed on the object, never a global.
 */
const bridges = new WeakSet<object>();

/** What {@link undiciGlobalDispatcher.install} changed, so `uninstall` can put back only its own. */
export interface InstalledDispatchers {
  base1: UndiciDispatcher;
  composed1: UndiciDispatcher;
  /** Set when `.2` held a dispatcher: what it held, and what replaced it. */
  base2?: UndiciDispatcher;
  composed2?: UndiciDispatcher;
}

function defineSlot(key: symbol, value: UndiciDispatcher): void {
  // undici's own descriptor, except configurable, so nothing is locked in.
  Object.defineProperty(globalThis, key, { value, writable: true, enumerable: false, configurable: true });
}

function writeSlot(key: symbol, value: UndiciDispatcher): void {
  if (key in globalThis) slots[key] = value;
  else defineSlot(key, value);
}

/**
 * The `.2` occupant for a process where only undici 6 (or older) has loaded:
 * it converts each new-API handler to the legacy API and dispatches through
 * whatever `.1` holds AT CALL TIME — the capture layer while it is installed,
 * the app's own dispatcher otherwise. A userland undici 8 loaded later then
 * shares Node's global dispatcher, as it already does on Node 24, instead of
 * overwriting `.1`. It follows `.1`, so it stays correct after `uninstall`
 * and is left in place; a `setGlobalDispatcher()` replaces it like any other.
 */
function legacyBridge(): UndiciDispatcher {
  const current = (): UndiciDispatcher & Record<string, unknown> =>
    slots[V1] as UndiciDispatcher & Record<string, unknown>;
  const dispatch = (opts: DispatchOptions, handler: DispatchHandler): unknown =>
    current().dispatch(opts, toLegacyHandler(handler));
  const view = (d: typeof dispatch): UndiciDispatcher & Record<string, unknown> => {
    const v: UndiciDispatcher & Record<string, unknown> = {
      dispatch: d,
      compose: (...interceptors: (DispatchInterceptor | DispatchInterceptor[] | null | undefined)[]) => {
        const list = (Array.isArray(interceptors[0]) ? interceptors[0] : interceptors) as (DispatchInterceptor | null)[];
        let next = d;
        for (const interceptor of list) if (interceptor) next = interceptor(next) as typeof dispatch;
        return view(next);
      },
      close: (...args: unknown[]) => (current().close as (...a: unknown[]) => unknown)?.(...args),
      destroy: (...args: unknown[]) => (current().destroy as (...a: unknown[]) => unknown)?.(...args)
    };
    bridges.add(v);
    return v;
  };
  return view(dispatch);
}

export const undiciGlobalDispatcher = {
  /**
   * The global dispatcher Node's `fetch()` uses (`.1`), loading Node's bundled
   * undici first if nothing has yet. `globalThis.fetch` is a plain wrapper that
   * loads undici on its first CALL, but `Headers` is a lazy getter over the same
   * module, and loading it creates the default global Agent. `undefined` on a
   * runtime without fetch (`--no-experimental-fetch`).
   */
  get(): UndiciDispatcher | undefined {
    void (globalThis as { Headers?: unknown }).Headers;
    const current = slots[V1];
    return current && typeof current.dispatch === 'function' ? current : undefined;
  },

  /**
   * Compose `interceptor` onto the global dispatcher(s) and install the result
   * the way undici's own `setGlobalDispatcher` does, per slot:
   *
   * - `.2` empty → `.1` gets the layer; `.2` gets the legacy bridge.
   * - `.2` holds the same dispatcher as `.1` (undici 7) → one layer, both slots.
   * - `.2` holds a different one (undici 8 loaded first) → a layer on each, so
   *   each family of callers passes the interceptor exactly once.
   */
  install(interceptor: DispatchInterceptor): InstalledDispatchers | undefined {
    const base1 = this.get();
    if (!base1) return undefined;
    const composed1 = composeDispatcher(base1, interceptor);
    const base2 = slots[V2];
    let composed2: UndiciDispatcher | undefined;
    if (base2 === base1) composed2 = composed1;
    else if (base2 && bridges.has(base2)) composed2 = undefined; // follows `.1`; already covered
    else if (base2 && typeof base2.dispatch === 'function') composed2 = composeDispatcher(base2, interceptor);

    writeSlot(V1, composed1);
    if (composed2) writeSlot(V2, composed2);
    else if (!base2) defineSlot(V2, legacyBridge());
    return composed2 ? { base1, composed1, base2, composed2 } : { base1, composed1 };
  },

  /** Put back each slot this installation still owns; a slot someone replaced since is left alone. */
  uninstall(installed: InstalledDispatchers): void {
    if (slots[V1] === installed.composed1) slots[V1] = installed.base1;
    if (installed.composed2 && installed.base2 && slots[V2] === installed.composed2) slots[V2] = installed.base2;
  }
};

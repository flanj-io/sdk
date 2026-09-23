import type { UndiciDispatcher } from './undici-types';

/**
 * undici keeps the process-wide dispatcher on `globalThis` under a registered
 * symbol, which is how every copy of undici — the one Node bundles behind
 * global `fetch()` and any userland one — agrees on a single global dispatcher.
 * undici 7 writes a second, versioned symbol as well and still READS the first,
 * so both are written whenever the second exists. `.1` is what undici 6 and 7
 * both read; that is the one this reads.
 */
const CURRENT = Symbol.for('undici.globalDispatcher.1');
const VERSIONED = Symbol.for('undici.globalDispatcher.2');

type Slots = Record<symbol, UndiciDispatcher | undefined>;

/**
 * The global dispatcher of the undici Node bundles, reached the way the SDK
 * reaches core modules: through the runtime, never by importing a package
 * (a userland `undici` is a different module, and its dispatcher is not the one
 * `fetch()` uses unless the app installed it).
 */
export const undiciGlobalDispatcher = {
  /**
   * The current global dispatcher, loading Node's bundled undici first if
   * nothing has yet. `globalThis.fetch` is a plain wrapper that loads undici on
   * its first CALL, but `Headers` is a lazy getter over the same module, and
   * loading that module creates the default global Agent. `undefined` on a
   * runtime without fetch (`--no-experimental-fetch`).
   */
  get(): UndiciDispatcher | undefined {
    void (globalThis as { Headers?: unknown }).Headers;
    const current = (globalThis as unknown as Slots)[CURRENT];
    return current && typeof current.dispatch === 'function' ? current : undefined;
  },

  /** Install `dispatcher` the way undici's own `setGlobalDispatcher` does. */
  set(dispatcher: UndiciDispatcher): void {
    const slots = globalThis as unknown as Slots;
    slots[CURRENT] = dispatcher;
    if (VERSIONED in globalThis) slots[VERSIONED] = dispatcher;
  }
};

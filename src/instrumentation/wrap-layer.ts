/**
 * Function patching that COEXISTS with other instrumentation.
 *
 * OTel's `InstrumentationBase._wrap` is `isWrapped → _unwrap → wrap`: before it
 * installs its own wrapper it REMOVES any wrapper already there. Two libraries
 * patching the same function that way are mutually exclusive, and the loser is
 * silent — measured on `node:http`'s `request`/`get`: OTel's
 * `@opentelemetry/instrumentation-http` alone records 2 spans, with Flanj's
 * `start()` in either order it recorded 0 while Flanj still captured.
 *
 * `wrapLayer` installs a wrapper that STACKS: it never unwraps what is there,
 * so the previous function stays in the call chain and both sides see the call.
 *
 * ## The marks, and the one shimmer mark deliberately withheld
 *
 * `shimmer` (and OTel's vendored copy) marks a wrapper with `__original`,
 * `__unwrap` and `__wrapped`, and `isWrapped()` requires ALL THREE. A layer here
 * carries the first two — so `shimmer.unwrap()` can still traverse it, instead of
 * logging "no original to unwrap to" — but NOT `__wrapped`, so `isWrapped(ours)`
 * is false and an OTel instrumentation registered AFTER us stacks on top of our
 * layer rather than tearing it out. That single omission is what makes the
 * Flanj-first order survivable.
 *
 * ## One live layer per tag
 *
 * A layer is tagged (the instrumentation's name) and knows whether its owner is
 * still enabled. `wrapLayer` walks the `__original` chain and declines to
 * install when a LIVE layer with the same tag is already in it, so a second
 * `start()` in one process cannot double-capture the same call. A layer whose
 * owner has been disabled does not count: it is an inert pass-through, and a
 * fresh instrumentation must be able to take over from it.
 */

/** The mark a Flanj layer carries. Cross-realm by `Symbol.for`, so two copies of the SDK still see one another. */
const LAYER = Symbol.for('flanj.instrumentation.layer');

type AnyFunction = (...args: never[]) => unknown;

/** Identity of one installed layer: who owns it, and whether that owner is still enabled. */
export interface LayerMark {
  /** Stable per patch role — the instrumentation name, not the instance. */
  tag: string;
  /** False once the owner is disabled: the layer stays installed but stops capturing. */
  isLive(): boolean;
}

/**
 * Install `wrapper` on `target[name]` ON TOP of whatever is already installed.
 *
 * Returns true when a layer was installed; false when there is nothing to wrap,
 * or a live layer with the same tag is already in the chain.
 */
export function wrapLayer(
  target: Record<string, unknown>,
  name: string,
  mark: LayerMark,
  wrapper: (original: AnyFunction) => AnyFunction
): boolean {
  const original = target[name];
  if (typeof original !== 'function') return false;
  if (hasLiveLayer(original, mark.tag)) return false;

  const wrapped = wrapper(original as AnyFunction);
  define(wrapped, LAYER, mark);
  // shimmer's traversal marks — minus `__wrapped`, see the file comment.
  define(wrapped, '__original', original);
  define(wrapped, '__unwrap', () => {
    // Pop only when still on top: someone may have stacked above us since.
    if (target[name] === wrapped) define(target, name, original);
  });
  define(target, name, wrapped);
  return true;
}

/**
 * Remove OUR layer from `target[name]` — and only ours.
 *
 * Returns true when it was removed. False means it was never there, or it is
 * buried under someone else's wrapper, which holds a direct reference to our
 * function and would lose the call chain if we spliced ourselves out. A buried
 * layer is neutralized instead, by its owner reporting `isLive() === false`.
 */
export function unwrapLayer(target: Record<string, unknown>, name: string, tag: string): boolean {
  const current = target[name];
  if (typeof current !== 'function') return false;
  if (markOf(current)?.tag !== tag) return false;
  const unwrap = (current as { __unwrap?: unknown }).__unwrap;
  if (typeof unwrap !== 'function') return false;
  (unwrap as () => void)();
  return target[name] !== current;
}

/** True when the `__original` chain from `fn` holds a layer with `tag` whose owner is still enabled. */
function hasLiveLayer(fn: unknown, tag: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = fn;
  while (typeof current === 'function' && !seen.has(current)) {
    seen.add(current);
    const mark = markOf(current);
    if (mark?.tag === tag && mark.isLive()) return true;
    current = (current as { __original?: unknown }).__original;
  }
  return false;
}

function markOf(fn: unknown): LayerMark | undefined {
  if (typeof fn !== 'function') return undefined;
  const mark = (fn as unknown as Record<symbol, unknown>)[LAYER];
  return isLayerMark(mark) ? mark : undefined;
}

function isLayerMark(value: unknown): value is LayerMark {
  if (typeof value !== 'object' || value === null) return false;
  const mark = value as Partial<LayerMark>;
  return typeof mark.tag === 'string' && typeof mark.isLive === 'function';
}

/**
 * Set a property the way `shimmer` does: configurable and writable so the next
 * library can patch over it, and enumerable only if the property it replaces
 * was (a module's `request` export stays enumerable; the marks do not appear).
 */
function define(target: object, key: string | symbol, value: unknown): void {
  const holder = target as Record<string | symbol, unknown>;
  const enumerable = Boolean(holder[key]) && Object.prototype.propertyIsEnumerable.call(target, key);
  Object.defineProperty(target, key, { configurable: true, enumerable, writable: true, value });
}

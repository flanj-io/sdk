import { describe, it, expect } from 'vitest';
import { isWrapped } from '@opentelemetry/instrumentation';
import { wrapLayer, unwrapLayer, type LayerMark } from './wrap-layer';

/**
 * The mechanism that lets Flanj share `http.request` with another
 * instrumentation. The end-to-end proof is
 * `test/integration/otel-coexistence.spec.ts`; this pins the three properties
 * that proof rests on: stacking, the withheld `__wrapped` mark, and removing
 * only our own layer.
 */

const TAG = 'flanj-test-layer';
const live: LayerMark = { tag: TAG, isLive: () => true };
const dead: LayerMark = { tag: TAG, isLive: () => false };

/** A module-exports-shaped holder with one function on it. */
function target(calls: string[]): Record<string, unknown> {
  return {
    request(...args: unknown[]): string {
      calls.push(`original(${String(args[0])})`);
      return 'response';
    }
  };
}

/** A wrapper that records that it ran, then delegates — like every real patch. */
function recorder(label: string, calls: string[]) {
  return (original: (...args: never[]) => unknown) =>
    function wrapped(this: unknown, ...args: unknown[]): unknown {
      calls.push(`${label}(${String(args[0])})`);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
}

/** shimmer's removal call, as OTel's `_unwrap` performs it. */
function shimmerUnwrap(mod: Record<string, unknown>, name: string): void {
  (mod[name] as { __unwrap: () => void }).__unwrap();
}

describe('wrapLayer', () => {
  it('stacks on an existing wrapper instead of replacing it', () => {
    const calls: string[] = [];
    const mod = target(calls);
    // Someone else patched first (OTel's span wrapper, in production).
    wrapLayer(mod, 'request', { tag: 'other', isLive: () => true }, recorder('other', calls));

    wrapLayer(mod, 'request', live, recorder('flanj', calls));
    (mod.request as (url: string) => string)('/charges');

    expect(calls).toEqual(['flanj(/charges)', 'other(/charges)', 'original(/charges)']);
  });

  it('does not answer OTel’s `isWrapped`, so an instrumentation registered later stacks on top', () => {
    // THE load-bearing assertion. `InstrumentationBase._wrap` is
    // `isWrapped → _unwrap → wrap`: a layer that reported itself wrapped would
    // be torn out by the next instrumentation to patch the same function.
    const mod = target([]);

    wrapLayer(mod, 'request', live, recorder('flanj', []));

    expect(isWrapped(mod.request)).toBe(false);
  });

  it('carries shimmer’s traversal marks so `shimmer.unwrap` still restores the original', () => {
    const calls: string[] = [];
    const mod = target(calls);
    const original = mod.request;

    wrapLayer(mod, 'request', live, recorder('flanj', calls));
    shimmerUnwrap(mod, 'request');

    expect(mod.request).toBe(original);
  });

  it('leaves the property enumerable when it was, and adds no enumerable marks', () => {
    const mod = target([]);

    wrapLayer(mod, 'request', live, recorder('flanj', []));

    expect(Object.keys(mod)).toEqual(['request']);
    expect(Object.keys(mod.request as object)).toEqual([]);
  });

  it('declines to install a second live layer with the same tag', () => {
    const calls: string[] = [];
    const mod = target(calls);
    wrapLayer(mod, 'request', live, recorder('first', calls));

    const installed = wrapLayer(mod, 'request', live, recorder('second', calls));
    (mod.request as (url: string) => string)('/charges');

    // A second start() in one process must not double-capture the same call.
    expect(installed).toBe(false);
    expect(calls).toEqual(['first(/charges)', 'original(/charges)']);
  });

  it('installs over a layer whose owner is disabled — an inert layer must not block a fresh one', () => {
    const calls: string[] = [];
    const mod = target(calls);
    wrapLayer(mod, 'request', dead, recorder('disabled', calls));

    const installed = wrapLayer(mod, 'request', live, recorder('fresh', calls));
    (mod.request as (url: string) => string)('/charges');

    expect(installed).toBe(true);
    expect(calls).toEqual(['fresh(/charges)', 'disabled(/charges)', 'original(/charges)']);
  });

  it('does nothing when there is no function to wrap', () => {
    const mod: Record<string, unknown> = { request: undefined };

    expect(wrapLayer(mod, 'request', live, recorder('flanj', []))).toBe(false);
    expect(mod.request).toBeUndefined();
  });
});

describe('unwrapLayer', () => {
  it('removes our layer when it is the outermost wrapper', () => {
    const calls: string[] = [];
    const mod = target(calls);
    const original = mod.request;
    wrapLayer(mod, 'request', live, recorder('flanj', calls));

    const removed = unwrapLayer(mod, 'request', TAG);

    expect(removed).toBe(true);
    expect(mod.request).toBe(original);
  });

  it('restores the layer BELOW ours, not the pristine original', () => {
    const calls: string[] = [];
    const mod = target(calls);
    wrapLayer(mod, 'request', { tag: 'other', isLive: () => true }, recorder('other', calls));
    const otherLayer = mod.request;
    wrapLayer(mod, 'request', live, recorder('flanj', calls));

    unwrapLayer(mod, 'request', TAG);
    (mod.request as (url: string) => string)('/charges');

    expect(mod.request).toBe(otherLayer);
    expect(calls).toEqual(['other(/charges)', 'original(/charges)']);
  });

  it('leaves a buried layer alone — splicing it out would break the wrapper above it', () => {
    const calls: string[] = [];
    const mod = target(calls);
    wrapLayer(mod, 'request', live, recorder('flanj', calls));
    // Another library wrapped after us; its closure holds our function directly.
    wrapLayer(mod, 'request', { tag: 'other', isLive: () => true }, recorder('other', calls));

    const removed = unwrapLayer(mod, 'request', TAG);
    (mod.request as (url: string) => string)('/charges');

    // Not removed, and still in the chain: neutralizing it is the owner's job
    // (`isEnabled()` is false, so the patch body is skipped).
    expect(removed).toBe(false);
    expect(calls).toEqual(['other(/charges)', 'flanj(/charges)', 'original(/charges)']);
  });

  it('does nothing for a tag that is not installed', () => {
    const mod = target([]);
    const untouched = mod.request;

    expect(unwrapLayer(mod, 'request', TAG)).toBe(false);
    expect(mod.request).toBe(untouched);
  });
});

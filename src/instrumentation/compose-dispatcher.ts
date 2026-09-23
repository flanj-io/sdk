import type { DispatchInterceptor, UndiciDispatcher } from './undici-types';

type Method = (...args: unknown[]) => unknown;

/**
 * Compose `interceptor` onto `base`, stacking rather than replacing it. Every
 * undici Node bundles (6.18+) has `compose`; a dispatcher without one (an older
 * userland copy, or a plain object with a `dispatch`) gets what undici 7's
 * `compose` itself returns: a view of the base whose `dispatch` is the
 * intercepted one and whose every other member is the base's own, bound to it.
 */
export function composeDispatcher(base: UndiciDispatcher, interceptor: DispatchInterceptor): UndiciDispatcher {
  if (typeof base.compose === 'function') return base.compose(interceptor);
  const dispatch = interceptor(base.dispatch.bind(base));
  return new Proxy(base, {
    get(target, key) {
      if (key === 'dispatch') return dispatch;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as Method).bind(target) : value;
    }
  });
}

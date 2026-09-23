import { describe, it, expect } from 'vitest';
import { teeDispatchHandler, type DispatchObserver } from './tee-dispatch-handler';

type Loose = Record<string, (...args: unknown[]) => unknown>;
/** The wrapped handler as undici sees it: callbacks called with whatever arguments the API passes. */
const loose = (h: object): Loose => h as unknown as Loose;

function recorder(): DispatchObserver & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    onResponseStart: (status, headers) => events.push(['start', status, headers]),
    onResponseData: (chunk) => events.push(['data', String(chunk)]),
    onResponseEnd: () => events.push(['end']),
    onAbandon: () => events.push(['abandon'])
  };
}

describe('teeDispatchHandler — undici 6 (legacy) handlers', () => {
  it('observes the response and forwards every call and return value (backpressure intact)', () => {
    const calls: string[] = [];
    const handler = {
      body: 'state',
      onConnect(): void {
        calls.push('connect');
      },
      onHeaders(): boolean {
        calls.push(`headers:${this.body}`);
        return true;
      },
      onData(): boolean {
        calls.push('data');
        return false; // pause
      },
      onComplete(): void {
        calls.push('complete');
      },
      onError(): void {
        calls.push('error');
      },
      onBodySent(): void {
        calls.push('bodySent');
      }
    };
    const obs = recorder();
    const wrapped = loose(teeDispatchHandler(handler, obs));

    wrapped.onConnect!();
    wrapped.onBodySent!();
    expect(wrapped.onHeaders!(200, [Buffer.from('Content-Type'), Buffer.from('application/json')], () => {}, 'OK')).toBe(true);
    expect(wrapped.onData!(Buffer.from('x'))).toBe(false);
    wrapped.onComplete!([]);

    expect(calls).toEqual(['connect', 'bodySent', 'headers:state', 'data', 'complete']);
    expect(obs.events).toEqual([['start', 200, { 'content-type': 'application/json' }], ['data', 'x'], ['end']]);
  });

  it('an error or upgrade abandons the call', () => {
    const obs = recorder();
    const h = { onHeaders: () => true, onData: () => true, onComplete: () => {}, onError: () => {}, onUpgrade: () => {} };
    loose(teeDispatchHandler(h, obs)).onError!(new Error('x'));
    loose(teeDispatchHandler(h, obs)).onUpgrade!();
    expect(obs.events).toEqual([['abandon'], ['abandon']]);
  });

  it('an observer that throws does not stop the original from being called', () => {
    let got = false;
    const obs = { ...recorder(), onResponseData: () => { throw new Error('observer bug'); } };
    const h = { onHeaders: () => true, onData: () => { got = true; return true; }, onComplete: () => {}, onError: () => {} };
    expect(loose(teeDispatchHandler(h, obs)).onData!(Buffer.from('x'))).toBe(true);
    expect(got).toBe(true);
  });
});

describe('teeDispatchHandler — undici 7 handlers', () => {
  class PrivateStateHandler {
    #seen: string[] = [];
    onRequestStart(): void {
      this.#seen.push('start');
    }
    onResponseStart(_c: unknown, status: number): void {
      this.#seen.push(`status:${status}`);
    }
    onResponseData(_c: unknown, chunk: Buffer): void {
      this.#seen.push(`data:${chunk}`);
    }
    onResponseEnd(): void {
      this.#seen.push('end');
    }
    onResponseError(): void {
      this.#seen.push('error');
    }
    seen(): string[] {
      return this.#seen;
    }
  }

  it('speaks the new API, observes parsed headers, and works with a handler that has private fields', () => {
    const inner = new PrivateStateHandler();
    const obs = recorder();
    const wrapped = loose(teeDispatchHandler(inner, obs));
    const controller = {};
    wrapped.onRequestStart!();
    wrapped.onResponseStart!(controller, 201, { 'Content-Type': 'text/plain' });
    wrapped.onResponseData!(controller, Buffer.from('hi'));
    wrapped.onResponseEnd!();
    expect(inner.seen()).toEqual(['start', 'status:201', 'data:hi', 'end']);
    expect(obs.events).toEqual([['start', 201, { 'content-type': 'text/plain' }], ['data', 'hi'], ['end']]);
  });

  it('does not invent a callback the original lacks (undici treats a missing onResponseError differently)', () => {
    const wrapped = teeDispatchHandler({ onRequestStart: () => {} }, recorder()) as Record<string, unknown>;
    expect(wrapped.onResponseError).toBeUndefined();
    expect(wrapped.onResponseData).toBeUndefined();
  });
});

describe('teeDispatchHandler — the wrapper itself', () => {
  const legacy = (): Record<string, () => unknown> => ({
    onConnect: () => {},
    onHeaders: () => true,
    onData: () => true,
    onComplete: () => {},
    onError: () => {}
  });

  it('shares one prototype per handler shape, and binds nothing per access', () => {
    // Arrange
    const a = teeDispatchHandler(legacy(), recorder());
    const b = teeDispatchHandler(legacy(), recorder());

    // Assert: same shape, same prototype; a method read twice is the same function.
    expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b));
    expect(loose(a).onData).toBe(loose(b).onData);
    expect(loose(a).onData).toBe(loose(a).onData);
  });

  it('presents exactly the optional callbacks the original has (onBodySent / onRequestSent / onResponseStarted)', () => {
    const without = teeDispatchHandler(legacy(), recorder()) as Record<string, unknown>;
    const sent: string[] = [];
    const withAll = loose(teeDispatchHandler(
      { ...legacy(), onBodySent: () => sent.push('body'), onRequestSent: () => sent.push('req'), onResponseStarted: () => sent.push('res') },
      recorder()
    ));

    expect(without.onBodySent).toBeUndefined();
    expect(without.onRequestSent).toBeUndefined();
    expect(without.onResponseStarted).toBeUndefined();
    withAll.onBodySent!(Buffer.from('x'));
    withAll.onRequestSent!();
    withAll.onResponseStarted!();
    expect(sent).toEqual(['body', 'req', 'res']);
  });

  it('forwards a method outside its API to the original, as the original — own or inherited', () => {
    class Future {
      #calls = 0;
      onRequestStart(): void {}
      onResponseEnd(): void {}
      onResponseTrailers(n: number): number {
        this.#calls += n;
        return this.#calls;
      }
    }
    const own = { ...legacy(), onSomethingNew: (x: unknown) => ['new', x] };

    const inherited = loose(teeDispatchHandler(new Future(), recorder()));
    const literal = loose(teeDispatchHandler(own, recorder()));

    expect(inherited.onResponseTrailers!(2)).toBe(2);
    expect(inherited.onResponseTrailers!(3)).toBe(5);
    expect(literal.onSomethingNew!(1)).toEqual(['new', 1]);
  });

  it('a handler that speaks both APIs is observed once, through the new one, and keeps its legacy callbacks', () => {
    const calls: string[] = [];
    const both = {
      onRequestStart: () => calls.push('requestStart'),
      onResponseStart: () => calls.push('responseStart'),
      onResponseData: () => calls.push('responseData'),
      onResponseEnd: () => calls.push('responseEnd'),
      onHeaders: () => calls.push('headers'),
      onData: () => calls.push('data')
    };
    const obs = recorder();
    const wrapped = loose(teeDispatchHandler(both, obs));

    wrapped.onResponseStart!({}, 200, {});
    wrapped.onResponseData!({}, Buffer.from('a'));
    wrapped.onHeaders!(200, []);
    wrapped.onData!(Buffer.from('b'));
    wrapped.onResponseEnd!({});

    expect(calls).toEqual(['responseStart', 'responseData', 'headers', 'data', 'responseEnd']);
    expect(obs.events).toEqual([['start', 200, {}], ['data', 'a'], ['end']]);
  });

  it('never invokes a getter on a handler prototype while looking for methods', () => {
    let reads = 0;
    class WithGetter {
      onRequestStart(): void {}
      get costly(): () => void {
        reads++;
        return () => {};
      }
    }

    teeDispatchHandler(new WithGetter(), recorder());

    expect(reads).toBe(0);
  });
});

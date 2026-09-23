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

import { describe, it, expect } from 'vitest';
import { toLegacyHandler } from './to-legacy-handler';

type Loose = Record<string, (...args: unknown[]) => unknown>;
const loose = (h: object): Loose => h as unknown as Loose;

describe('toLegacyHandler', () => {
  it('returns a legacy handler unchanged', () => {
    const legacy = { onConnect: () => {}, onHeaders: () => true, onData: () => true, onComplete: () => {}, onError: () => {} };
    expect(toLegacyHandler(legacy)).toBe(legacy);
  });

  it('drives a new-API handler from legacy callbacks, with parsed headers and trailers', () => {
    const seen: unknown[] = [];
    const modern = {
      onRequestStart: (_c: unknown, ctx: unknown) => seen.push(['start', ctx]),
      onResponseStart: (_c: unknown, status: number, headers: unknown, text: string) =>
        seen.push(['headers', status, headers, text]),
      onResponseData: (_c: unknown, chunk: Buffer) => seen.push(['data', chunk.toString()]),
      onResponseEnd: (_c: unknown, trailers: unknown) => seen.push(['end', trailers]),
      onResponseError: () => seen.push(['error'])
    };
    const legacy = loose(toLegacyHandler(modern));
    legacy.onConnect!(() => {}, { ctx: 1 });
    expect(legacy.onHeaders!(200, [Buffer.from('Content-Type'), Buffer.from('text/plain')], () => {}, 'OK')).toBe(true);
    expect(legacy.onData!(Buffer.from('hi'))).toBe(true);
    legacy.onComplete!([Buffer.from('X-T'), Buffer.from('1')]);
    expect(seen).toEqual([
      ['start', { ctx: 1 }],
      ['headers', 200, { 'content-type': 'text/plain' }, 'OK'],
      ['data', 'hi'],
      ['end', { 'x-t': '1' }]
    ]);
  });

  it('maps pause to a false return and resume to the resume callback; abort reaches the socket', () => {
    let resumed = 0;
    let abortedWith: unknown;
    let controller: { pause(): void; resume(): void; abort(r: unknown): void; aborted: boolean } | undefined;
    const modern = {
      onRequestStart: (c: typeof controller) => {
        controller = c;
      },
      onResponseStart: () => controller?.pause(),
      onResponseData: () => {},
      onResponseEnd: () => {},
      onResponseError: () => {}
    };
    const legacy = loose(toLegacyHandler(modern));
    legacy.onConnect!((reason: unknown) => {
      abortedWith = reason;
    });
    expect(legacy.onHeaders!(200, [], () => (resumed += 1), 'OK')).toBe(false);
    controller?.resume();
    expect(resumed).toBe(1);
    expect(legacy.onData!(Buffer.from('x'))).toBe(true);
    controller?.abort('stop');
    expect(abortedWith).toBe('stop');
    expect(controller?.aborted).toBe(true);
  });

  it('an error without onResponseError is rethrown, as undici expects', () => {
    const legacy = loose(toLegacyHandler({ onRequestStart: () => {} }));
    expect(() => legacy.onError!(new Error('boom'))).toThrow('boom');
  });
});

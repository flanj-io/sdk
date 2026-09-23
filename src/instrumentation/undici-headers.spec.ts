import { describe, it, expect } from 'vitest';
import { normalizeUndiciHeaders } from './undici-headers';

describe('normalizeUndiciHeaders', () => {
  it('reads a plain object, lowercasing names and keeping arrays', () => {
    expect(normalizeUndiciHeaders({ 'Content-Type': 'application/json', 'set-cookie': ['a=1', 'b=2'] })).toEqual({
      'content-type': 'application/json',
      'set-cookie': ['a=1', 'b=2']
    });
  });

  it("reads undici 6's flat raw array of Buffers", () => {
    const raw = [Buffer.from('Content-Type'), Buffer.from('text/plain'), Buffer.from('X-Request-Id'), Buffer.from('r1')];
    expect(normalizeUndiciHeaders(raw)).toEqual({ 'content-type': 'text/plain', 'x-request-id': 'r1' });
  });

  it('accumulates a repeated name in a flat array', () => {
    expect(normalizeUndiciHeaders(['vary', 'a', 'Vary', 'b'])).toEqual({ vary: ['a', 'b'] });
  });

  it('reads an iterable of pairs (Headers, Map) and an array of pairs', () => {
    expect(normalizeUndiciHeaders(new Headers({ 'X-A': '1' }))).toEqual({ 'x-a': '1' });
    expect(normalizeUndiciHeaders(new Map([['X-B', '2']]))).toEqual({ 'x-b': '2' });
    expect(normalizeUndiciHeaders([['X-C', '3']])).toEqual({ 'x-c': '3' });
  });

  it('stringifies numbers and drops null values; unknown shapes are empty, never a throw', () => {
    expect(normalizeUndiciHeaders({ 'content-length': 12, gone: null })).toEqual({ 'content-length': '12' });
    expect(normalizeUndiciHeaders(undefined)).toEqual({});
    expect(normalizeUndiciHeaders('nope')).toEqual({});
  });
});

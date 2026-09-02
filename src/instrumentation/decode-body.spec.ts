import { describe, it, expect } from 'vitest';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { decodeBody } from './decode-body';

const CAP = 16384;
const JSON_BODY = JSON.stringify({ contact: 'jane@acme.test', source: '4111111111111111' });
const PLAIN = Buffer.from(JSON_BODY, 'utf8');

describe('decodeBody — no content coding', () => {
  it('passes plain bytes through as UTF-8', () => {
    expect(decodeBody(PLAIN, undefined, CAP, false)).toEqual({ text: JSON_BODY, decoded: true, truncated: false });
  });

  it('treats identity as no coding', () => {
    expect(decodeBody(PLAIN, 'identity', CAP, false).text).toBe(JSON_BODY);
  });

  it('carries the input truncation flag through untouched', () => {
    expect(decodeBody(PLAIN, undefined, CAP, true).truncated).toBe(true);
  });
});

describe('decodeBody — codings it can undo', () => {
  it('decodes gzip', () => {
    const out = decodeBody(gzipSync(PLAIN), 'gzip', CAP, false);
    expect(out).toEqual({ text: JSON_BODY, decoded: true, truncated: false });
  });

  it('decodes brotli', () => {
    expect(decodeBody(brotliCompressSync(PLAIN), 'br', CAP, false).text).toBe(JSON_BODY);
  });

  it('decodes zlib-wrapped deflate', () => {
    expect(decodeBody(deflateSync(PLAIN), 'deflate', CAP, false).text).toBe(JSON_BODY);
  });

  it('decodes a raw (headerless) deflate stream advertised as deflate', () => {
    expect(decodeBody(deflateRawSync(PLAIN), 'deflate', CAP, false).text).toBe(JSON_BODY);
  });

  it('matches the coding case-insensitively and ignores surrounding space', () => {
    expect(decodeBody(gzipSync(PLAIN), ' GZIP ', CAP, false).text).toBe(JSON_BODY);
  });

  it('accepts the x- prefixed aliases', () => {
    expect(decodeBody(gzipSync(PLAIN), 'x-gzip', CAP, false).text).toBe(JSON_BODY);
  });
});

describe('decodeBody — truncated and oversized payloads', () => {
  it('decodes the prefix of a stream that was cut at the byte cap', () => {
    const whole = gzipSync(Buffer.from(JSON_BODY.repeat(20), 'utf8'));
    const cut = whole.subarray(0, whole.length - 20);

    const out = decodeBody(cut, 'gzip', CAP, true);

    expect(out.decoded).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text.startsWith('{"contact":"jane@acme.test"')).toBe(true);
  });

  it('keeps a capped prefix — never the whole thing — when the payload inflates past the cap', () => {
    const bomb = gzipSync(Buffer.from('y'.repeat(200_000), 'utf8'));

    const out = decodeBody(bomb, 'gzip', 1024, false);

    expect(out.decoded).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(1024);
  });
});

describe('decodeBody — the honest-empty path', () => {
  it('keeps NO body for a coding it cannot undo', () => {
    const out = decodeBody(Buffer.from('(µ/ý garbage', 'binary'), 'zstd', CAP, false);

    expect(out).toEqual({ text: '', decoded: false, truncated: false });
  });

  it('keeps NO body for a stacked coding chain (it does not unwind chains)', () => {
    expect(decodeBody(brotliCompressSync(gzipSync(PLAIN)), 'gzip, br', CAP, false)).toEqual({
      text: '',
      decoded: false,
      truncated: false
    });
  });

  it('keeps NO body when the declared coding does not match the bytes', () => {
    expect(decodeBody(PLAIN, 'gzip', CAP, false)).toEqual({ text: '', decoded: false, truncated: false });
  });

  it('never returns the raw wire bytes it failed to decode', () => {
    const raw = gzipSync(PLAIN);

    const out = decodeBody(raw, 'zstd', CAP, false);

    expect(out.text).toBe('');
    expect(out.text).not.toContain(raw.toString('utf8').slice(0, 4));
  });

  it('is empty (but decoded) for an empty compressed body', () => {
    expect(decodeBody(Buffer.alloc(0), 'gzip', CAP, false)).toEqual({ text: '', decoded: true, truncated: false });
  });
});

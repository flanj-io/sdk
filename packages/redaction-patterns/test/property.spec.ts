import { describe, it, expect } from 'vitest';
import { createRedactor, passesLuhn } from '../src/index';

/**
 * Property test: plant public test PANs (in every format the floor claims to handle) at random
 * positions of randomly generated nested payloads, and assert that NO Luhn-valid 13–19 digit run
 * survives in the redacted output, PAN is reported, and redaction is idempotent. Deterministic
 * (seeded PRNG) so a failure is reproducible; complements the fixture contract with breadth.
 */

const PANS = ['4111111111111111', '5555555555554444', '378282246310005', '4242424242424242', '6011111111111117', '30569309025904', '4222222222222', '4111111111111111110'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function group(pan: string, sep: string, sizes: number[]): string {
  const parts: string[] = [];
  let i = 0;
  for (const n of sizes) {
    if (i >= pan.length) break;
    parts.push(pan.slice(i, i + n));
    i += n;
  }
  if (i < pan.length) parts.push(pan.slice(i));
  return parts.join(sep);
}

function formatPan(pan: string, rnd: () => number): unknown {
  const pick = Math.floor(rnd() * 7);
  switch (pick) {
    case 0:
      return pan;
    case 1:
      return group(pan, ' ', [4, 4, 4, 4]);
    case 2:
      return group(pan, '-', [4, 4, 4, 4]);
    case 3:
      return pan.length === 15 ? group(pan, ' ', [4, 6, 5]) : group(pan, ' ', [4, 4, 4, 4, 3]);
    case 4:
      return `card ${pan} exp 12/30`;
    case 5:
      return Buffer.from(JSON.stringify({ card: pan, amount: 1200 })).toString('base64');
    default:
      return pan.length <= 16 ? Number(pan) : pan; // PAN as a JSON number (safe integer range only)
  }
}

function genValue(depth: number, rnd: () => number, plant: () => unknown): unknown {
  const r = rnd();
  // Top level is always a container (a real body); a bare top-level number/string body is
  // covered by the text-path unit tests (it becomes a bare token, which is not JSON).
  if (depth > 0 && (depth > 4 || r < 0.25)) {
    const scalar = rnd();
    if (scalar < 0.2) return plant();
    if (scalar < 0.4) return Math.floor(rnd() * 100000);
    if (scalar < 0.5) return rnd() < 0.5;
    if (scalar < 0.55) return null;
    return ['ok', 'Jane', 'usd', 'order-1234', 'the charge succeeded', 'id_98765'][Math.floor(rnd() * 6)];
  }
  if (r < 0.6) {
    const obj: Record<string, unknown> = {};
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const key = rnd() < 0.05 ? (plant() as string) : ['a', 'b', 'c', 'data', 'meta', 'items', 'card', 'x'][Math.floor(rnd() * 8)] + i;
      obj[String(key)] = genValue(depth + 1, rnd, plant);
    }
    return obj;
  }
  const n = 1 + Math.floor(rnd() * 4);
  return Array.from({ length: n }, () => genValue(depth + 1, rnd, plant));
}

function luhnRuns(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![A-Za-z0-9_])\d(?:[ -]?\d){12,18}(?![A-Za-z0-9_])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) out.push(m[0]);
  }
  return out;
}

describe('property: no planted PAN survives, in any format, at any position', () => {
  const redactor = createRedactor();
  const rnd = mulberry32(20260819);

  for (let round = 0; round < 300; round++) {
    it(`payload #${round}`, () => {
      let planted = 0;
      const plant = (): unknown => {
        planted++;
        return formatPan(PANS[Math.floor(rnd() * PANS.length)]!, rnd);
      };
      let payload = genValue(0, rnd, plant);
      if (planted === 0) payload = { forced: plant() };

      // Structural path
      const s = redactor.redact(payload);
      expect(luhnRuns(JSON.stringify(s.redacted))).toEqual([]);
      expect(s.hits).toContain('PAN');
      expect(redactor.redact(s.redacted)).toEqual({ redacted: s.redacted, hits: [] });

      // Text path over the serialized body (compact and pretty-printed)
      for (const text of [JSON.stringify(payload), JSON.stringify(payload, null, 2)]) {
        const t = redactor.redactText(text);
        expect(luhnRuns(t.text)).toEqual([]);
        expect(t.patterns).toContain('PAN');
        expect(redactor.redactText(t.text)).toEqual({ text: t.text, patterns: [] });
        expect(JSON.parse(t.text)).toEqual(s.redacted); // both paths agree structurally
      }
    });
  }
});

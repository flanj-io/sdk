import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { redact, redactDetailed } from '../src/index';

/**
 * THE security floor conformance suite. The vector file — not this code — is the
 * contract. Every case (positives, negatives, idempotency, multi) must pass, and
 * the idempotency + add-only invariants are enforced across the whole set.
 */

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, '../../../contracts/redaction-vectors.json');

interface Vector {
  id: string;
  description: string;
  input: string;
  expected: string;
  patterns: string[];
}

const vectors: { cases: Vector[] } = JSON.parse(readFileSync(vectorsPath, 'utf8'));

describe('redaction-vectors.json conformance', () => {
  it('loads the vendored golden vector file', () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.cases) {
    describe(`${vector.id} — ${vector.description}`, () => {
      it('produces the expected redacted text', () => {
        const actual = redact(vector.input);
        expect(actual).toBe(vector.expected);
      });

      it('reports the expected fired patterns', () => {
        const { patterns } = redactDetailed(vector.input);
        expect(patterns).toEqual(vector.patterns);
      });

      it('is idempotent: redact(redact(x)) === redact(x)', () => {
        const once = redact(vector.input);
        const twice = redact(once);
        expect(twice).toBe(once);
      });

      it('re-redacting the expected output is inert (add-only)', () => {
        // The golden expected output must be a fixed point of redaction.
        expect(redact(vector.expected)).toBe(vector.expected);
      });
    });
  }
});

describe('redaction invariants', () => {
  it('never un-redacts an emitted token', () => {
    const input = '{"source":"⟦REDACTED:PAN⟧","email":"⟦REDACTED:EMAIL⟧"}';
    expect(redact(input)).toBe(input);
    expect(redactDetailed(input).patterns).toEqual([]);
  });

  it('is idempotent for a body carrying many PII types at once', () => {
    const input = 'pan 4111111111111111 mail a@b.com iban DE89370400440532013000 ssn 123-45-6789 tel +14155552671';
    const once = redact(input);
    expect(redact(once)).toBe(once);
    expect(once).not.toContain('4111111111111111');
    expect(once).not.toContain('a@b.com');
  });
});

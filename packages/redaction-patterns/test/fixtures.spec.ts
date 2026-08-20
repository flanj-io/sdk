import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRedactor, enhance, redactDetailed, REDACTED_TOKEN_RE } from '../src/index';
import type { PatternId, SensitiveField } from '../src/index';

/**
 * THE cross-language PARITY suite. `contracts/redaction-fixtures.json` (vendored from the canonical
 * `e2e/contracts/v1`) is run by this suite AND by the Go collector's suite; both must produce these exact
 * results. This file is the contract, not the code.
 *
 *  - kind=json: BOTH entry points are asserted — the structural `redact(value)` and the text path
 *    `redactText(JSON.stringify(value))` parsed back — by deep-equality (the parity oracle).
 *  - kind=text: the text path must match byte-for-byte.
 *  - every case must be idempotent (redacting `expected` is a no-op that fires nothing).
 *  - `enhancer` cases run the schema-aware enhancer on the floor's output; and the never-subtract law is
 *    asserted over the cross product of every json case x every spec in the file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = resolve(here, '../../../contracts/redaction-fixtures.json');

interface FixtureCase {
  id: string;
  description: string;
  kind: 'json' | 'text';
  direction: 'inbound' | 'outbound' | 'any';
  input: unknown;
  expected: unknown;
  patterns: PatternId[];
  enhancer?: { spec: SensitiveField[]; expected: unknown; patterns: PatternId[] };
}

const fixtures: { cases: FixtureCase[] } = JSON.parse(readFileSync(fixturesPath, 'utf8'));
const redactor = createRedactor();

/** Every ⟦REDACTED:…⟧ token in a value, keyed by its JSON path — the never-subtract oracle. */
function tokensByPath(value: unknown, path = '$', out = new Map<string, string[]>()): Map<string, string[]> {
  if (typeof value === 'string') {
    const found = value.match(REDACTED_TOKEN_RE);
    if (found) out.set(path, found);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => tokensByPath(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyTokens = k.match(REDACTED_TOKEN_RE);
      if (keyTokens) out.set(`${path}.<key:${k}>`, keyTokens);
      tokensByPath(v, `${path}.${k}`, out);
    }
  }
  return out;
}

describe('redaction-fixtures.json — cross-language parity suite', () => {
  it('loads the vendored fixture file', () => {
    expect(fixtures.cases.length).toBeGreaterThan(50);
  });

  for (const c of fixtures.cases) {
    describe(`${c.id} — ${c.description}`, () => {
      if (c.kind === 'json') {
        it('structural redact(value) deep-equals expected', () => {
          const { redacted, hits } = redactor.redact(c.input);
          expect(redacted).toEqual(c.expected);
          expect(hits).toEqual(c.patterns);
        });

        it('text path redactText(JSON.stringify(value)) parses back to expected', () => {
          const { text, patterns } = redactor.redactText(JSON.stringify(c.input));
          expect(JSON.parse(text)).toEqual(c.expected);
          expect(patterns).toEqual(c.patterns);
        });

        it('is idempotent on the structural path', () => {
          const again = redactor.redact(c.expected);
          expect(again.redacted).toEqual(c.expected);
          expect(again.hits).toEqual([]);
        });

        it('never mutates its input', () => {
          const frozen = JSON.stringify(c.input);
          redactor.redact(c.input);
          expect(JSON.stringify(c.input)).toBe(frozen);
        });
      } else {
        it('text path matches byte-for-byte', () => {
          const { text, patterns } = redactor.redactText(c.input as string);
          expect(text).toBe(c.expected);
          expect(patterns).toEqual(c.patterns);
        });

        it('the module-level redactDetailed agrees', () => {
          expect(redactDetailed(c.input as string).text).toBe(c.expected);
        });
      }

      it('is idempotent on the text path', () => {
        const expectedText = c.kind === 'json' ? JSON.stringify(c.expected) : (c.expected as string);
        const again = redactor.redactText(expectedText);
        expect(again.text).toBe(expectedText);
        expect(again.patterns).toEqual([]);
      });

      if (c.enhancer) {
        it('schema-aware enhancer produces the expected enhanced value', () => {
          const floor = redactor.redact(c.input);
          const enhanced = enhance(floor.redacted, c.enhancer!.spec);
          expect(enhanced.redacted).toEqual(c.enhancer!.expected);
          expect(enhanced.hits).toEqual(c.enhancer!.patterns);
        });
      }
    });
  }
});

describe('never-subtract law: enhancer(floor(x), spec) ⊇ floor(x) for every json case × every spec', () => {
  const specs: SensitiveField[][] = [[], ...fixtures.cases.filter((c) => c.enhancer).map((c) => c.enhancer!.spec)];
  // A hostile spec: points at every floor-redacted field with a different type, plus wildcards.
  specs.push([
    { path: 'card_number', type: 'EMAIL' },
    { path: 'card', type: 'IP' },
    { path: 'cards[]', type: 'TOKEN' },
    { path: 'items[].pan', type: 'SSN' },
    { path: 'charge.source.card_number', type: 'PHONE' },
    { path: 'payment.card.number', type: 'EMAIL' }
  ]);

  for (const c of fixtures.cases.filter((x) => x.kind === 'json')) {
    it(`${c.id}: floor tokens survive every spec unchanged`, () => {
      const floor = redactor.redact(c.input);
      const before = tokensByPath(floor.redacted);
      for (const spec of specs) {
        const after = tokensByPath(enhance(floor.redacted, spec).redacted);
        for (const [path, toks] of before) {
          expect(after.get(path), `spec ${JSON.stringify(spec)} removed/changed tokens at ${path}`).toEqual(toks);
        }
      }
    });
  }
});

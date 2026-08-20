import { describe, it, expect } from 'vitest';
import {
  createRedactor,
  redactDetailed,
  PAN_RECOGNIZER,
  EMAIL_RECOGNIZER,
  IBAN_RECOGNIZER,
  PHONE_RECOGNIZER,
  CVV_RECOGNIZER,
  TOKEN_RECOGNIZER,
  IP_RECOGNIZER,
  enhance
} from '../src/index';
import type { Recognizer } from '../src/index';

/**
 * Behaviour NOT pinned by the cross-language fixtures (which are the contract): the
 * optional IP recognizer, the swappable-interface mechanics, and recognizer edge cases
 * that document deliberate choices. Anything that must hold in Go too belongs in
 * contracts/redaction-fixtures.json, not here.
 */

describe('Recognizer interface', () => {
  it('PAN returns confirmed spans only (Luhn-gated) with original-span offsets', () => {
    const text = 'a 4111 1111 1111 1111 b 1111111111111111 c';
    expect(PAN_RECOGNIZER.find(text, {})).toEqual([{ start: 2, end: 21 }]);
  });

  it('PAN is anchored against word characters on both sides', () => {
    expect(PAN_RECOGNIZER.find('x4111111111111111', {})).toEqual([]);
    expect(PAN_RECOGNIZER.find('4111111111111111x', {})).toEqual([]);
    expect(PAN_RECOGNIZER.find('_4111111111111111', {})).toEqual([]);
    expect(PAN_RECOGNIZER.find('(4111111111111111)', {})).toEqual([{ start: 1, end: 17 }]);
  });

  it('PAN never treats more than five groups as one card (digit lists are not PANs)', () => {
    // 16 single-digit groups — a valid Luhn sequence but not a PAN format.
    expect(PAN_RECOGNIZER.find('4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1', {})).toEqual([]);
  });

  it('EMAIL trims leading punctuation and validates', () => {
    expect(EMAIL_RECOGNIZER.find('see ...jane@example.com', {})).toEqual([{ start: 7, end: 23 }]);
    expect(EMAIL_RECOGNIZER.find('not-an-email@', {})).toEqual([]);
    expect(EMAIL_RECOGNIZER.find('a@b', {})).toEqual([]);
  });

  it('IBAN accepts lowercase and rejects a wrong country or checksum', () => {
    expect(IBAN_RECOGNIZER.find('de89370400440532013000', {})).toEqual([{ start: 0, end: 22 }]);
    expect(IBAN_RECOGNIZER.find('ZZ89370400440532013000', {})).toEqual([]);
    expect(IBAN_RECOGNIZER.find('DE00370400440532013000', {})).toEqual([]);
  });

  it('PHONE requires a + country code and validates against metadata', () => {
    expect(PHONE_RECOGNIZER.find('+14155552671', {})).toEqual([{ start: 0, end: 12 }]);
    expect(PHONE_RECOGNIZER.find('14155552671', {})).toEqual([]);
    expect(PHONE_RECOGNIZER.find('+1234', {})).toEqual([]);
    expect(PHONE_RECOGNIZER.find('x+14155552671', {})).toEqual([]);
  });

  it('CVV is contextual in both key and text modes', () => {
    expect(CVV_RECOGNIZER.find('123', { key: 'cvv' })).toEqual([{ start: 0, end: 3 }]);
    expect(CVV_RECOGNIZER.find('123', { key: 'retries' })).toEqual([]);
    expect(CVV_RECOGNIZER.find('123', {})).toEqual([]);
    expect(CVV_RECOGNIZER.find('the cvv was 123 today', { key: 'note' })).toEqual([]);
    expect(CVV_RECOGNIZER.find('cvv: 123', {})).toEqual([{ start: 5, end: 8 }]);
    expect(CVV_RECOGNIZER.find('cvv: 12345', {})).toEqual([]);
  });

  it('TOKEN validates the JWT header and keeps the longest overlapping span', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0.abcdefghij';
    expect(TOKEN_RECOGNIZER.find(`Bearer ${jwt}`, {})).toEqual([{ start: 7, end: 7 + jwt.length }]);
    expect(TOKEN_RECOGNIZER.find('eyJxxxxxx.yyyyyyyy.zzzzzzzz', {})).toEqual([]);
  });

  it('IP recognizer validates octets and v6 shapes', () => {
    expect(IP_RECOGNIZER.find('from 10.0.0.1 to 256.1.1.1', {})).toEqual([{ start: 5, end: 13 }]);
    expect(IP_RECOGNIZER.find('v6 2001:db8::1 time 12:30:45', {})).toEqual([{ start: 3, end: 14 }]);
    expect(IP_RECOGNIZER.find('version 1.2.3.4.5', {})).toEqual([]);
  });
});

describe('createRedactor options', () => {
  it('IP is off by default and on with includeIp', () => {
    const body = { peer: '203.0.113.7' };
    expect(createRedactor().redact(body)).toEqual({ redacted: body, hits: [], fields: [] });
    expect(createRedactor({ includeIp: true }).redact(body)).toEqual({
      redacted: { peer: '⟦REDACTED:IP⟧' },
      hits: ['IP'],
      fields: [
        {
          path: '/peer',
          pattern: 'IP',
          props: {
            type: 'string',
            length: 11,
            containsLowerCase: false,
            containsUpperCase: false,
            containsDigits: true,
            containsASCIIControlChars: false,
            containsASCIIPrintableChars: true,
            containsASCIIExtendedChars: false
          }
        }
      ]
    });
  });

  it('recognizers are swappable behind the interface without touching traversal/base64/tokens', () => {
    const shout: Recognizer = {
      id: 'TOKEN',
      find: (v) => {
        const at = v.indexOf('secret');
        return at >= 0 ? [{ start: at, end: at + 6 }] : [];
      }
    };
    const r = createRedactor({ recognizers: [shout] });
    const out = r.redact({ a: ['secret', 'plain'], b: { c: 'secret' } });
    expect(out.redacted).toEqual({ a: ['⟦REDACTED:TOKEN⟧', 'plain'], b: { c: '⟦REDACTED:TOKEN⟧' } });
    expect(out.hits).toEqual(['TOKEN']);
    expect(out.fields.map((f) => f.path)).toEqual(['/a/0', '/b/c']); // whole-value hits carry paths
    // base64 decode-then-scan is owned by the wrapper, not the recognizer.
    expect(r.redactText(Buffer.from('the secret is out').toString('base64')).patterns).toEqual(['TOKEN']);
  });

  it('redacts keys as well as values; colliding redacted keys keep the last value', () => {
    const out = createRedactor().redact({ '4111111111111111': 'a', '4242424242424242': 'b' });
    expect(out.redacted).toEqual({ '⟦REDACTED:PAN⟧': 'b' });
  });

  it('structural path leaves non-string, non-number scalars alone', () => {
    const r = createRedactor();
    expect(r.redact(true).redacted).toBe(true);
    expect(r.redact(null).redacted).toBe(null);
    expect(r.redact(undefined).redacted).toBe(undefined);
    expect(r.redact(4111111111111111).redacted).toBe('⟦REDACTED:PAN⟧');
    expect(r.redact(1200).redacted).toBe(1200);
    expect(r.redact(1.5).redacted).toBe(1.5);
  });
});

describe('text path robustness', () => {
  it('handles an empty body', () => {
    expect(redactDetailed('')).toEqual({ text: '', patterns: [], fields: [] });
  });

  it('a JSON string body (top-level scalar) is scanned', () => {
    expect(redactDetailed('"4111111111111111"').text).toBe('"⟦REDACTED:PAN⟧"');
  });

  it('handles escaped JSON strings and re-encodes canonically', () => {
    const input = '{"note":"line1\\nline2 4111111111111111 \\"q\\" \\u00e9"}';
    expect(redactDetailed(input).text).toBe('{"note":"line1\\nline2 ⟦REDACTED:PAN⟧ \\"q\\" é"}');
  });

  it('a URL with a query string goes through the form-aware path', () => {
    expect(redactDetailed('https://api.example.com/v1/x?card=4111111111111111&cb=a%20b').text).toBe(
      'https://api.example.com/v1/x?card=⟦REDACTED:PAN⟧&cb=a%20b'
    );
  });

  it('never mutates shared state across calls (fresh regex state)', () => {
    const a = redactDetailed('a@b.com and c@d.com');
    const b = redactDetailed('a@b.com and c@d.com');
    expect(a).toEqual(b);
    expect(a.text).toBe('⟦REDACTED:EMAIL⟧ and ⟦REDACTED:EMAIL⟧');
  });
});

describe('enhancer', () => {
  it('ignores unknown types and malformed paths', () => {
    const v = { a: 'x' };
    expect(enhance(v, [{ path: 'a', type: 'NOPE' as never }]).redacted).toEqual(v);
    expect(enhance(v, [{ path: '', type: 'PAN' }]).redacted).toEqual(v);
    expect(enhance(v, [{ path: '.a', type: 'PAN' }]).redacted).toEqual(v);
  });

  it('never replaces containers', () => {
    const v = { a: { b: 'x' } };
    expect(enhance(v, [{ path: 'a', type: 'PAN' }]).redacted).toEqual(v);
  });

  it('does not mutate its input', () => {
    const v = { a: 'x' };
    enhance(v, [{ path: 'a', type: 'PAN' }]);
    expect(v).toEqual({ a: 'x' });
  });
});

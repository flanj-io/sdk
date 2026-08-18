import { describe, it, expect } from 'vitest';
import { redactHeaders, DEFAULT_HEADER_ALLOWLIST } from '../src/index';

describe('redactHeaders', () => {
  it('keeps only allowlisted keys and drops everything else', () => {
    const out = redactHeaders({
      'content-type': 'application/json',
      'x-request-id': 'req_1',
      'x-internal-secret': 'super-secret-value'
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'x-request-id': 'req_1' });
  });

  it('drops authorization/cookie by default (not in the allowlist)', () => {
    const out = redactHeaders({ authorization: 'Bearer sk_live_abc', cookie: 'sid=1' });
    expect(out).toEqual({});
  });

  it('forces credential headers to a TOKEN token when explicitly allowlisted', () => {
    const out = redactHeaders({ authorization: 'Bearer sk_live_abc' }, [...DEFAULT_HEADER_ALLOWLIST, 'authorization']);
    expect(out.authorization).toBe('⟦REDACTED:TOKEN⟧');
    expect(JSON.stringify(out)).not.toContain('sk_live_abc');
  });

  it('lowercases keys and redacts PII in surviving values', () => {
    const out = redactHeaders({ 'X-Request-Id': 'contact jane@example.com' });
    expect(out['x-request-id']).toBe('contact ⟦REDACTED:EMAIL⟧');
  });

  it('is empty for undefined input', () => {
    expect(redactHeaders(undefined)).toEqual({});
  });
});

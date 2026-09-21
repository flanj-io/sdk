import { describe, it, expect } from 'vitest';
import { assembleCapturedCall, type AssembleCallInput } from './assemble-call';

const PAN = '4111111111111111';
const EMAIL = 'jane@acme.test';

function input(overrides: Partial<AssembleCallInput>): AssembleCallInput {
  return {
    direction: 'client',
    peerHost: 'api.acme.test',
    edgeClass: 'external',
    captureBodies: true,
    method: 'POST',
    protocol: 'https:',
    host: 'api.acme.test',
    path: '/v1/charges',
    statusCode: 422,
    reqBodyRaw: JSON.stringify({ amount: 1200, source: PAN }),
    reqBodyTruncated: false,
    resBodyRaw: JSON.stringify({ type: 'https://acme.test/errors/card', title: 'Card declined', contact: EMAIL }),
    resBodyTruncated: true,
    requestHeaders: {},
    responseHeaders: {},
    correlation: {},
    durationMs: 12,
    ...overrides
  };
}

/**
 * The gate is applied per direction inside the assembler; these pin the
 * behaviour where the defect showed — a `problem+json` error response used to
 * come out as an empty body with `truncated: false`, indistinguishable from a
 * provider that sent nothing.
 */
describe('assembleCapturedCall — structured-suffix JSON bodies are captured and redacted', () => {
  it('keeps and redacts an application/problem+json response on an external edge', () => {
    const call = assembleCapturedCall(
      input({ reqContentType: 'application/json', resContentType: 'application/problem+json; charset=utf-8' })
    );

    expect(call.responseBody).toContain('⟦REDACTED:EMAIL⟧');
    expect(call.responseBody).toContain('"title":"Card declined"');
    expect(call.responseBody).not.toContain(EMAIL);
    expect(call.responseBodyTruncated).toBe(true);
    expect(call.responseContentType).toBe('application/problem+json; charset=utf-8');
    expect(call.redactionPatterns).toEqual(['PAN', 'EMAIL']);
  });

  it('keeps and redacts an application/vnd.api+json request the same way', () => {
    const call = assembleCapturedCall(
      input({ reqContentType: 'application/vnd.api+json', resContentType: 'application/vnd.api+json' })
    );

    expect(call.requestBody).toContain('⟦REDACTED:PAN⟧');
    expect(call.requestBody).not.toContain(PAN);
    expect(call.redactionFields.map((f) => f.part)).toEqual(['request', 'response']);
  });

  it('still drops a binary body entirely — no redaction, no truncation flag', () => {
    const call = assembleCapturedCall(
      input({ reqContentType: 'multipart/form-data; boundary=x', resContentType: 'application/octet-stream' })
    );

    expect(call.requestBody).toBe('');
    expect(call.responseBody).toBe('');
    expect(call.responseBodyTruncated).toBe(false);
    expect(call.redactionFields).toEqual([]);
    expect(JSON.stringify(call)).not.toContain(PAN);
    expect(JSON.stringify(call)).not.toContain(EMAIL);
  });

  it('honours an operator override that leaves application/json out', () => {
    const call = assembleCapturedCall(
      input({
        reqContentType: 'application/json',
        resContentType: 'application/problem+json',
        captureContentTypes: ['text/']
      })
    );

    expect(call.requestBody).toBe('');
    expect(call.responseBody).toBe('');
    expect(call.redactionApplied).toBe(false);
  });
});

/**
 * CONTRACTS §2: `flanj.http.route` is the path ("templated if known … else path"),
 * `flanj.http.target` is the redacted path+query. They used to be the same string,
 * so every distinct query string was a distinct route.
 */
describe('assembleCapturedCall — route is the path, target is path+query', () => {
  it('drops the query string from route and keeps it in target', () => {
    const call = assembleCapturedCall(input({ path: '/v1/accounts/acct_1/balance?fields=all' }));

    expect(call.route).toBe('/v1/accounts/acct_1/balance');
    expect(call.target).toBe('/v1/accounts/acct_1/balance?fields=all');
    expect(call.urlFull).toBe('https://api.acme.test/v1/accounts/acct_1/balance?fields=all');
  });

  it('leaves a path with no query string as it was: route equals target', () => {
    const call = assembleCapturedCall(input({ path: '/v1/charges' }));

    expect(call.route).toBe('/v1/charges');
    expect(call.target).toBe('/v1/charges');
  });

  it('stops at a fragment too, whichever delimiter comes first', () => {
    expect(assembleCapturedCall(input({ path: '/v1/docs#intro' })).route).toBe('/v1/docs');
    expect(assembleCapturedCall(input({ path: '/v1/docs?page=2#intro' })).route).toBe('/v1/docs');
    expect(assembleCapturedCall(input({ path: '/v1/docs#intro?page=2' })).route).toBe('/v1/docs');
  });

  it('still reports a pattern that fired only in the query string — target carries it', () => {
    const call = assembleCapturedCall(
      input({ path: `/v1/accounts/acct_1/balance?notify=${EMAIL}`, reqBodyRaw: '', resBodyRaw: '' })
    );

    expect(call.route).toBe('/v1/accounts/acct_1/balance');
    expect(call.target).toBe('/v1/accounts/acct_1/balance?notify=⟦REDACTED:EMAIL⟧');
    expect(call.redactionPatterns).toEqual(['EMAIL']);
    expect(call.redactionApplied).toBe(true);
    expect(JSON.stringify(call)).not.toContain(EMAIL);
  });

  it('keeps a redaction that fired in the path itself', () => {
    const call = assembleCapturedCall(input({ path: `/v1/cards/${PAN}?expand=owner`, reqBodyRaw: '', resBodyRaw: '' }));

    expect(call.route).toBe('/v1/cards/⟦REDACTED:PAN⟧');
    expect(call.target).toBe('/v1/cards/⟦REDACTED:PAN⟧?expand=owner');
    expect(call.redactionPatterns).toEqual(['PAN']);
  });

  /**
   * Why the cut comes AFTER redaction. The floor tokenises this value only when a
   * query string sits beside it; redacting a pre-cut path would hand `route` the
   * raw `123` that `target` hid. A slice of the redacted target cannot.
   */
  it('never shows in route a value that target redacted', () => {
    const call = assembleCapturedCall(input({ path: '/v1/pay/cvv=123?x=1', reqBodyRaw: '', resBodyRaw: '' }));

    expect(call.target).toBe('/v1/pay/cvv=⟦REDACTED:CVV⟧?x=1');
    expect(call.route).toBe('/v1/pay/cvv=⟦REDACTED:CVV⟧');
    expect(call.route).not.toContain('123');
    expect(call.target.startsWith(call.route)).toBe(true);
  });

  it('gives an empty path the root route, never an empty string', () => {
    expect(assembleCapturedCall(input({ path: '?fields=all' })).route).toBe('/');
    expect(assembleCapturedCall(input({ path: '' })).route).toBe('/');
    expect(assembleCapturedCall(input({ path: '?fields=all' })).target).toBe('?fields=all');
  });

  it('takes an opaque path whole: a ? or # in a name is not a query', () => {
    const call = assembleCapturedCall(input({ path: '/what?now#then', opaquePath: true }));

    expect(call.route).toBe('/what?now#then');
    expect(call.target).toBe('/what?now#then');
  });
});

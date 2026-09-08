import { describe, it, expect } from 'vitest';
import { assembleCapturedCall, type AssembleCallInput } from './assemble-call';

const PAN = '4111111111111111';
const EMAIL = 'jane@acme.test';

function input(overrides: Partial<AssembleCallInput>): AssembleCallInput {
  return {
    integration: 'acme-payments',
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

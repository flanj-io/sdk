import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildLogAttributes } from './otlp-record';
import { CapturedCall } from './captured-call';

/**
 * Locks the CapturedCall → flanj.* mapping to the golden fixture: the exact
 * attribute key set and the scalar values that the collector's contract test
 * expects to ingest.
 */

const golden = JSON.parse(
  readFileSync(resolve(__dirname, '../../contracts/golden-otlp-call.json'), 'utf8')
) as { resourceLogs: any[] };

const goldenRecord = golden.resourceLogs[0].scopeLogs[0].logRecords[0];
const goldenAttrs: Record<string, unknown> = {};
for (const a of goldenRecord.attributes) {
  const v = a.value;
  goldenAttrs[a.key] =
    v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : v.boolValue);
}

const call: CapturedCall = {
  integration: 'acme-payments',
  direction: 'client',
  peerHost: 'api.acme.test',
  edgeClass: 'external',
  captureBodies: true,
  method: 'POST',
  route: '/v1/charges',
  target: '/v1/charges',
  urlFull: 'https://api.acme.test/v1/charges',
  statusCode: 200,
  requestContentType: 'application/json',
  requestBody: '{"amount":1200,"currency":"usd","source":"⟦REDACTED:PAN⟧"}',
  requestBodyTruncated: false,
  requestHeaders: { 'content-type': 'application/json', 'idempotency-key': 'idem_9f2c1a' },
  responseContentType: 'application/json',
  responseBody:
    '{"id":"ch_1Mox","object":"charge","amount":"1200","currency":"usd","status":"succeeded","created":1755504000,"card":{"last4":"1111","brand":"visa"}}',
  responseBodyTruncated: false,
  responseHeaders: { 'content-type': 'application/json', 'x-request-id': 'req_0Vy9aX2bK' },
  correlation: {
    requestId: 'req_0Vy9aX2bK',
    idempotencyKey: 'idem_9f2c1a',
    traceId: '5b8efff798038103d269b633813fc60c',
    spanId: 'eee19b7ec3c1b174'
  },
  durationMs: 42,
  redactionApplied: true,
  redactionPatterns: ['PAN'],
  redactionSpecAware: false,
  redactionFields: []
};

describe('buildLogAttributes vs golden-otlp-call.json', () => {
  const attrs = buildLogAttributes(call);

  it('produces exactly the golden attribute key set', () => {
    expect(new Set(Object.keys(attrs))).toEqual(new Set(Object.keys(goldenAttrs)));
  });

  it('matches every golden scalar value', () => {
    for (const [key, expected] of Object.entries(goldenAttrs)) {
      expect(attrs[key], `attribute ${key}`).toEqual(expected);
    }
  });

  it('serializes headers and patterns as JSON strings', () => {
    expect(attrs['flanj.http.request.headers']).toBe(
      '{"content-type":"application/json","idempotency-key":"idem_9f2c1a"}'
    );
    expect(attrs['flanj.redaction.patterns']).toBe('["PAN"]');
  });

  it('never emits a raw PAN', () => {
    expect(JSON.stringify(attrs)).not.toContain('4111111111111111');
  });

  it('emits flanj.peer.addr only when the socket exposed one', () => {
    // Absent on the golden call: the key must not appear at all.
    expect('flanj.peer.addr' in attrs).toBe(false);
    const withAddr = buildLogAttributes({ ...call, peerAddr: '203.0.113.7' });
    expect(withAddr['flanj.peer.addr']).toBe('203.0.113.7');
    // The optional attr must be the ONLY difference vs the golden key set.
    expect(new Set(Object.keys(withAddr))).toEqual(new Set([...Object.keys(goldenAttrs), 'flanj.peer.addr']));
  });
});

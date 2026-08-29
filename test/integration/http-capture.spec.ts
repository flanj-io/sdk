import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { ClientRequest, RequestOptions } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type FlanjHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';

/**
 * Drives a REAL http request through an in-process server and asserts the emitted
 * OTLP log record: all required flanj.* attributes present, bodies redacted,
 * shape matching contracts/golden-otlp-call.json — and no raw body reachable.
 */

const PAN_IN_REQUEST = '4111111111111111';
// Drifting response: `amount` is the STRING "1200" where spec-v1 declares integer.
const DRIFT_RESPONSE = JSON.stringify({
  id: 'ch_1Mox',
  object: 'charge',
  amount: '1200',
  currency: 'usd',
  status: 'succeeded',
  created: 1755504000,
  card: { last4: '1111', brand: 'visa' }
});

const golden = JSON.parse(
  readFileSync(resolve(__dirname, '../../contracts/golden-otlp-call.json'), 'utf8')
) as { resourceLogs: unknown[] };

function goldenAttributeKeys(): Set<string> {
  const rec = (golden.resourceLogs as any)[0].scopeLogs[0].logRecords[0];
  return new Set(rec.attributes.map((a: { key: string }) => a.key));
}

let server: Server;
let handle: FlanjHandle;
const exporter = new InMemoryLogExporter();

beforeAll(async () => {
  // Register a context manager so trace/span context propagates (as it would
  // when the host app runs the OTel tracing SDK). Without one, context.with is a no-op.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  server = createServer((req, res) => {
    // consume request body
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-id', 'req_0Vy9aX2bK');
      res.statusCode = 200;
      res.end(DRIFT_RESPONSE);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  handle = start({
    integration: 'acme-payments',
    serviceName: 'acme-consumer',
    processor: new SimpleLogRecordProcessor({ exporter })
  });
});

afterAll(async () => {
  await handle.shutdown();
  await new Promise<void>((r) => server.close(() => r()));
});

async function driveCall(): Promise<string> {
  // Run inside an active span context so corr.trace_id/span_id populate.
  const ctx = trace.setSpanContext(context.active(), {
    traceId: '5b8efff798038103d269b633813fc60c',
    spanId: 'eee19b7ec3c1b174',
    traceFlags: 1
  });
  // Resolve `request` from the LIVE module AFTER start() has patched it — mirrors
  // real usage where the SDK is started before the app makes its calls.
  const liveHttp = (process as unknown as {
    getBuiltinModule(id: string): { request(url: string, opts: RequestOptions, cb: (res: import('node:http').IncomingMessage) => void): ClientRequest };
  }).getBuiltinModule('node:http');
  // Target an EXTERNAL hostname (so the edge classifies external and bodies are
  // captured) that resolves to the in-process loopback server via a custom lookup.
  const port = (server.address() as AddressInfo).port;
  // Node calls the connect lookup with `{ all: true }`, expecting an array of
  // { address, family }; otherwise a bare (address, family). Handle both.
  const lookup = ((_hostname: string, opts: { all?: boolean }, cb: (err: null, ...rest: unknown[]) => void): void => {
    if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  }) as unknown as RequestOptions['lookup'];
  return context.with(ctx, () => {
    return new Promise<string>((resolvePromise, reject) => {
      const req = liveHttp.request(
        `http://api.acme.test:${port}/v1/charges`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'idem_9f2c1a' },
          lookup
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ amount: 1200, currency: 'usd', source: PAN_IN_REQUEST }));
    });
  });
}

describe('http body capture → OTLP log record', () => {
  let attrs: Record<string, unknown>;
  let appResponseBody: string;

  beforeAll(async () => {
    appResponseBody = await driveCall();
    // allow the response 'end' / finalize microtask to run
    await new Promise((r) => setTimeout(r, 20));
    // The in-process server also yields an ingress record now — select the egress one.
    const clientRecords = exporter.records.filter((r) => r.attributes['flanj.direction'] === 'client');
    expect(clientRecords.length).toBe(1);
    const record = clientRecords[0];
    attrs = record.attributes as Record<string, unknown>;
  });

  it('does not disturb the app: the consumer still reads the full response body', () => {
    expect(JSON.parse(appResponseBody).amount).toBe('1200');
  });

  it('emits every required flanj.* attribute key from the golden record', () => {
    const required = goldenAttributeKeys();
    for (const key of required) {
      expect(attrs, `missing attribute ${key}`).toHaveProperty(key);
    }
  });

  it('sets the fixed convention values', () => {
    expect(attrs['flanj.capture.version']).toBe('1');
    expect(attrs['flanj.record.type']).toBe('call');
    expect(attrs['flanj.direction']).toBe('client');
    expect(attrs['flanj.integration']).toBe('acme-payments');
    expect(attrs['flanj.http.method']).toBe('POST');
    expect(attrs['flanj.http.route']).toBe('/v1/charges');
    expect(attrs['flanj.http.status_code']).toBe(200);
    expect(attrs['flanj.redaction.spec_aware']).toBe(false);
  });

  it('carries the correlation keys front-and-center', () => {
    expect(attrs['flanj.corr.request_id']).toBe('req_0Vy9aX2bK');
    expect(attrs['flanj.corr.idempotency_key']).toBe('idem_9f2c1a');
    expect(attrs['flanj.corr.trace_id']).toBe('5b8efff798038103d269b633813fc60c');
    expect(attrs['flanj.corr.span_id']).toBe('eee19b7ec3c1b174');
  });

  it('REDACTS the request body at source — the raw PAN is unreachable', () => {
    const reqBody = attrs['flanj.http.request.body'] as string;
    expect(reqBody).toContain('⟦REDACTED:PAN⟧');
    expect(reqBody).not.toContain(PAN_IN_REQUEST);
    expect(attrs['flanj.redaction.applied']).toBe(true);
    expect(JSON.parse(attrs['flanj.redaction.patterns'] as string)).toContain('PAN');
  });

  it('captures the drifting response body verbatim (amount as string "1200")', () => {
    const resBody = attrs['flanj.http.response.body'] as string;
    expect(JSON.parse(resBody).amount).toBe('1200');
  });

  it('allowlists headers (no raw authorization/cookie ever emitted)', () => {
    const reqHeaders = JSON.parse(attrs['flanj.http.request.headers'] as string);
    expect(reqHeaders['content-type']).toBe('application/json');
    expect(reqHeaders['idempotency-key']).toBe('idem_9f2c1a');
    const serialized = JSON.stringify(attrs);
    expect(serialized.toLowerCase()).not.toContain('authorization');
  });

  it('proves no raw body survived anywhere in the emitted attributes', () => {
    expect(JSON.stringify(attrs)).not.toContain(PAN_IN_REQUEST);
  });
});

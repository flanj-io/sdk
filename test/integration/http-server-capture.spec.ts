import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type RequestOptions } from 'node:http';
import { AddressInfo } from 'node:net';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type ViniferaHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';

/**
 * INGRESS (server-path) capture: an in-process server receives a POST, the SDK
 * emits a `direction="server"` record with peer.host + edge.class + redacted
 * bodies — and the app's OWN handler still reads the full, unmodified body.
 *
 * The client that drives the request connects over loopback, which classifies
 * internal. To exercise the EXTERNAL path we set `X-Forwarded-For` (as a proxy
 * would), making the caller a public IP; a second call with NO forwarded header
 * exercises the INTERNAL / metadata-only path.
 */

const PAN = '4111111111111111'; // valid-Luhn test Visa
const RESPONSE_EMAIL = 'agent@acme.test';

let server: Server;
let baseUrl: string;
let handle: ViniferaHandle;
const exporter = new InMemoryLogExporter();
/** What the app's own request handler read off the wire, keyed by request path. */
const handlerBodies: Record<string, string> = {};

beforeAll(async () => {
  handle = start({
    integration: 'acme-payments',
    serviceName: 'acme-provider',
    processor: new SimpleLogRecordProcessor({ exporter })
  });

  // Server created AFTER start(); the prototype patch applies to it regardless.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      handlerBodies[req.url ?? ''] = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-id', 'req_srv_9');
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, contact: RESPONSE_EMAIL }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await handle.shutdown();
  await new Promise<void>((r) => server.close(() => r()));
});

function driveCall(path: string, headers: Record<string, string>, body: string): Promise<string> {
  const liveHttp = (process as unknown as {
    getBuiltinModule(id: string): {
      request(url: string, opts: RequestOptions, cb: (res: IncomingMessage) => void): import('node:http').ClientRequest;
    };
  }).getBuiltinModule('node:http');
  return new Promise<string>((resolvePromise, reject) => {
    const req = liveHttp.request(`${baseUrl}${path}`, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function serverRecordFor(path: string): Record<string, unknown> {
  const rec = exporter.records.find(
    (r) =>
      (r.attributes as Record<string, unknown>)['vinifera.direction'] === 'server' &&
      (r.attributes as Record<string, unknown>)['vinifera.http.target'] === path
  );
  if (!rec) throw new Error(`no server record for ${path}`);
  return rec.attributes as Record<string, unknown>;
}

describe('ingress (server) capture — EXTERNAL caller (X-Forwarded-For)', () => {
  let attrs: Record<string, unknown>;
  let appResponse: string;

  beforeAll(async () => {
    appResponse = await driveCall(
      '/v1/charges',
      {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'x-request-id': 'req_client_in',
        'idempotency-key': 'idem_in_1'
      },
      JSON.stringify({ amount: 1200, source: PAN })
    );
    await new Promise((r) => setTimeout(r, 30));
    attrs = serverRecordFor('/v1/charges');
  });

  it('emits a direction=server record classified from the caller', () => {
    expect(attrs['vinifera.direction']).toBe('server');
    expect(attrs['vinifera.record.type']).toBe('call');
    expect(attrs['vinifera.peer.host']).toBe('203.0.113.7'); // first XFF hop
    expect(attrs['vinifera.edge.class']).toBe('external');
    expect(attrs['vinifera.capture.bodies']).toBe(true);
    expect(attrs['vinifera.http.method']).toBe('POST');
    expect(attrs['vinifera.http.route']).toBe('/v1/charges');
    expect(attrs['vinifera.http.status_code']).toBe(200);
  });

  it('REDACTS the incoming request body at source — raw PAN unreachable', () => {
    const reqBody = attrs['vinifera.http.request.body'] as string;
    expect(reqBody).toContain('⟦REDACTED:PAN⟧');
    expect(reqBody).not.toContain(PAN);
    expect(attrs['vinifera.redaction.applied']).toBe(true);
    expect(JSON.parse(attrs['vinifera.redaction.patterns'] as string)).toContain('PAN');
  });

  it('REDACTS the response body at source (email tokenized)', () => {
    const resBody = attrs['vinifera.http.response.body'] as string;
    expect(resBody).toContain('⟦REDACTED:EMAIL⟧');
    expect(resBody).not.toContain(RESPONSE_EMAIL);
  });

  it('carries header-derived correlation (request id + idempotency key)', () => {
    // trace/span populate from an active SERVER span when the host runs OTel
    // tracing; this in-process harness has none, so only header correlation is present.
    expect(attrs['vinifera.corr.request_id']).toBe('req_client_in');
    expect(attrs['vinifera.corr.idempotency_key']).toBe('idem_in_1');
  });

  it('does NOT disturb the app: its handler read the full raw body (PAN intact)', () => {
    expect(handlerBodies['/v1/charges']).toContain(PAN);
    expect(JSON.parse(appResponse).ok).toBe(true);
  });

  it('proves no raw PAN survived anywhere in the emitted attributes', () => {
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });
});

describe('ingress (server) capture — INTERNAL caller (metadata-only)', () => {
  let attrs: Record<string, unknown>;

  beforeAll(async () => {
    // No X-Forwarded-For -> caller is the loopback socket peer -> internal.
    await driveCall('/internal/ping', { 'content-type': 'application/json' }, JSON.stringify({ secret: PAN }));
    await new Promise((r) => setTimeout(r, 30));
    attrs = serverRecordFor('/internal/ping');
  });

  it('classifies the loopback caller as internal, metadata-only', () => {
    expect(attrs['vinifera.direction']).toBe('server');
    expect(attrs['vinifera.edge.class']).toBe('internal');
    expect(attrs['vinifera.capture.bodies']).toBe(false);
  });

  it('captures NO body for an internal edge (no raw internal body ever emitted)', () => {
    expect(attrs['vinifera.http.request.body']).toBe('');
    expect(attrs['vinifera.http.response.body']).toBe('');
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });

  it('still lets the app read the full raw body', () => {
    expect(handlerBodies['/internal/ping']).toContain(PAN);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type RequestOptions } from 'node:http';
import { AddressInfo } from 'node:net';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type FlanjHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';

/**
 * The DEFAULT: no trusted proxies configured. `X-Forwarded-For` is
 * client-controlled, so with nobody declared trustworthy it must be ignored
 * outright — the socket peer is the caller, whatever the header claims.
 *
 * This used to be the first hop of the header, unconditionally: any caller
 * could send `X-Forwarded-For: 10.0.0.1` and be classified internal, so its
 * bodies were never captured and drift detection went blind for that call,
 * silently; and an internal caller could claim a public address and have its
 * bodies stored, which the metadata-only rule for internal edges exists to
 * prevent. Its own process because `start()` patches the process-wide
 * http module: one SDK configuration per process.
 */

const PAN = '4111111111111111';

let server: Server;
let baseUrl: string;
let handle: FlanjHandle;
const exporter = new InMemoryLogExporter();
const handlerBodies: Record<string, string> = {};

beforeAll(async () => {
  delete process.env.FLANJ_TRUSTED_PROXIES;
  handle = start({
    integration: 'acme-payments',
    serviceName: 'acme-provider',
    processor: new SimpleLogRecordProcessor({ exporter })
  });
  expect(handle.serverInstrumentation.getConfig().trustedProxies).toBeUndefined();

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      handlerBodies[req.url ?? ''] = Buffer.concat(chunks).toString('utf8');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, contact: 'agent@acme.test' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
      (r.attributes as Record<string, unknown>)['flanj.direction'] === 'server' &&
      (r.attributes as Record<string, unknown>)['flanj.http.target'] === path
  );
  if (!rec) throw new Error(`no server record for ${path}`);
  return rec.attributes as Record<string, unknown>;
}

describe.each([
  { name: 'a public first hop', path: '/untrusted/public', xff: '203.0.113.7' },
  { name: 'a public chain', path: '/untrusted/chain', xff: '203.0.113.7, 198.51.100.4' },
  { name: 'a private first hop', path: '/untrusted/private', xff: '10.0.0.1' }
])('ingress (server) capture — NO trusted proxies, X-Forwarded-For claims $name', ({ path, xff }) => {
  let attrs: Record<string, unknown>;

  beforeAll(async () => {
    await driveCall(
      path,
      { 'content-type': 'application/json', 'x-forwarded-for': xff },
      JSON.stringify({ amount: 1200, source: PAN })
    );
    await new Promise((r) => setTimeout(r, 30));
    attrs = serverRecordFor(path);
  });

  it('ignores the header: the caller is the loopback socket peer, classified internal', () => {
    expect(attrs['flanj.peer.host']).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(attrs['flanj.edge.class']).toBe('internal');
    expect(attrs['flanj.capture.bodies']).toBe(false);
    expect(JSON.stringify(attrs)).not.toContain(xff.split(',')[0]);
  });

  it('captures NO body (metadata-only) and no raw PAN reaches the record', () => {
    expect(attrs['flanj.http.request.body']).toBe('');
    expect(attrs['flanj.http.response.body']).toBe('');
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });

  it('still lets the app read the full raw body', () => {
    expect(handlerBodies[path]).toContain(PAN);
  });
});

describe('start() — an unparseable trusted proxy entry fails the boot', () => {
  // LAST in this file: start() enables the egress instrumentation before the
  // ingress one throws, so the http client path is wrapped twice from here on.
  it('throws at start(), naming the entry, rather than silently trusting nobody', () => {
    expect(() =>
      start({
        integration: 'x',
        trustedProxies: ['proxy.internal'],
        processor: new SimpleLogRecordProcessor({ exporter })
      })
    ).toThrow(/"proxy.internal" is not an IP address or CIDR/);
  });
});

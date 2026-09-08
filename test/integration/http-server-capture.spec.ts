import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type RequestOptions } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type FlanjHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';

/**
 * INGRESS (server-path) capture: an in-process server receives a POST, the SDK
 * emits a `direction="server"` record with peer.host + edge.class + redacted
 * bodies — and the app's OWN handler still reads the full, unmodified body.
 *
 * The client that drives the request connects over loopback, which classifies
 * internal. To exercise the EXTERNAL path this process plays the org's own
 * reverse proxy: loopback is declared a TRUSTED PROXY (via `FLANJ_TRUSTED_PROXIES`,
 * the zero-code env route; the `trustedProxies` option is exercised in the
 * sibling `http-server-capture-untrusted.spec.ts`) and the driver sets
 * `X-Forwarded-For` the way a proxy would, ending with the hop the proxy
 * appended. A call with NO forwarded header exercises the INTERNAL /
 * metadata-only path. That sibling spec starts the SDK WITHOUT trusted proxies
 * and proves the header is then ignored outright.
 */

const PAN = '4111111111111111'; // valid-Luhn test Visa
const RESPONSE_EMAIL = 'agent@acme.test';

let server: Server;
let baseUrl: string;
let handle: FlanjHandle;
const exporter = new InMemoryLogExporter();
/** What the app's own request handler read off the wire, keyed by request path. */
const handlerBodies: Record<string, string> = {};

beforeAll(async () => {
  // Loopback (both spellings) and the 172.16/12 block are "our proxy tier"; 10/8
  // and 192.168/16 deliberately are NOT, so a hop there is an untrusted caller.
  process.env.FLANJ_TRUSTED_PROXIES = '127.0.0.0/8, ::1, 172.16.0.0/12';
  handle = start({
    integration: 'acme-payments',
    serviceName: 'acme-provider',
    processor: new SimpleLogRecordProcessor({ exporter })
  });
  delete process.env.FLANJ_TRUSTED_PROXIES;
  // The env route reached the ingress instrumentation, parsed as a list.
  expect(handle.serverInstrumentation.getConfig().trustedProxies).toEqual(['127.0.0.0/8', '::1', '172.16.0.0/12']);

  // Server created AFTER start(); the prototype patch applies to it regardless.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      handlerBodies[req.url ?? ''] = Buffer.concat(chunks).toString('utf8');
      const body = JSON.stringify({ ok: true, contact: RESPONSE_EMAIL });
      // The Fastify shape: headers go straight to writeHead, setHeader is never
      // called — so Node populates no outgoing-header map at all. Node accepts
      // three header shapes there; each route below exercises one.
      if (req.url === '/writehead/charges') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_srv_wh' });
        res.end(body);
        return;
      }
      if (req.url === '/writehead/reason') {
        res.writeHead(200, 'OK', { 'Content-Type': 'application/json', 'X-Request-Id': 'req_srv_wh' });
        res.end(body);
        return;
      }
      if (req.url === '/writehead/flat-array') {
        res.writeHead(200, ['Content-Type', 'application/json', 'X-Request-Id', 'req_srv_wh']);
        res.end(body);
        return;
      }
      if (req.url === '/writehead/gzip') {
        // The compression-middleware shape: the app writes plaintext, but the
        // bytes reaching our write/end tee are already compressed.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        res.end(gzipSync(Buffer.from(body, 'utf8')));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-request-id', 'req_srv_9');
      res.statusCode = 200;
      res.end(body);
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
      (r.attributes as Record<string, unknown>)['flanj.direction'] === 'server' &&
      (r.attributes as Record<string, unknown>)['flanj.http.target'] === path
  );
  if (!rec) throw new Error(`no server record for ${path}`);
  return rec.attributes as Record<string, unknown>;
}

describe('ingress (server) capture — EXTERNAL caller via the trusted proxy (X-Forwarded-For)', () => {
  let attrs: Record<string, unknown>;
  let appResponse: string;

  beforeAll(async () => {
    // The chain a real proxy hands over when the CLIENT itself sent
    // "X-Forwarded-For: 10.0.0.1" (exploit (a): claim a private first hop so
    // the call classifies internal and no body is captured): the proxy appends
    // the client's real address, and THAT hop is the caller.
    appResponse = await driveCall(
      '/v1/charges',
      {
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.1, 203.0.113.7',
        'x-request-id': 'req_client_in',
        'idempotency-key': 'idem_in_1'
      },
      JSON.stringify({ amount: 1200, source: PAN })
    );
    await new Promise((r) => setTimeout(r, 30));
    attrs = serverRecordFor('/v1/charges');
  });

  it('emits a direction=server record classified from the hop the proxy appended, not the leftmost', () => {
    expect(attrs['flanj.direction']).toBe('server');
    expect(attrs['flanj.record.type']).toBe('call');
    expect(attrs['flanj.peer.host']).toBe('203.0.113.7'); // the rightmost untrusted hop
    expect(attrs['flanj.edge.class']).toBe('external');
    expect(attrs['flanj.capture.bodies']).toBe(true);
    expect(attrs['flanj.http.method']).toBe('POST');
    expect(attrs['flanj.http.route']).toBe('/v1/charges');
    expect(attrs['flanj.http.status_code']).toBe(200);
  });

  it('keeps the socket address (the proxy) as flanj.peer.addr — transport detail, not identity', () => {
    expect(attrs['flanj.peer.addr']).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it('REDACTS the incoming request body at source — raw PAN unreachable', () => {
    const reqBody = attrs['flanj.http.request.body'] as string;
    expect(reqBody).toContain('⟦REDACTED:PAN⟧');
    expect(reqBody).not.toContain(PAN);
    expect(attrs['flanj.redaction.applied']).toBe(true);
    expect(JSON.parse(attrs['flanj.redaction.patterns'] as string)).toContain('PAN');
  });

  it('REDACTS the response body at source (email tokenized)', () => {
    const resBody = attrs['flanj.http.response.body'] as string;
    expect(resBody).toContain('⟦REDACTED:EMAIL⟧');
    expect(resBody).not.toContain(RESPONSE_EMAIL);
  });

  it('carries header-derived correlation (request id + idempotency key)', () => {
    // trace/span populate from an active SERVER span when the host runs OTel
    // tracing; this in-process harness has none, so only header correlation is present.
    expect(attrs['flanj.corr.request_id']).toBe('req_client_in');
    expect(attrs['flanj.corr.idempotency_key']).toBe('idem_in_1');
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
    expect(attrs['flanj.direction']).toBe('server');
    expect(attrs['flanj.edge.class']).toBe('internal');
    expect(attrs['flanj.capture.bodies']).toBe(false);
  });

  it('captures NO body for an internal edge (no raw internal body ever emitted)', () => {
    expect(attrs['flanj.http.request.body']).toBe('');
    expect(attrs['flanj.http.response.body']).toBe('');
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });

  it('still lets the app read the full raw body', () => {
    expect(handlerBodies['/internal/ping']).toContain(PAN);
  });
});

/**
 * The A/B against the `setHeader` case above: an app that replies via
 * `writeHead(status, headers)` — Fastify's `reply.js` does exactly
 * `res.writeHead(statusCode, reply[kReplyHeaders])`. Node's writeHead fast path
 * never populates the outgoing-header map, so `res.getHeaders()` and
 * `res.getHeader('content-type')` are both empty and the response bytes — already
 * teed — used to be discarded by the content-type gate, leaving request-only rows.
 */
describe('ingress (server) capture — an app that replies via writeHead', () => {
  let attrs: Record<string, unknown>;

  beforeAll(async () => {
    await driveCall(
      '/writehead/charges',
      {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.9',
        'x-request-id': 'req_client_wh'
      },
      JSON.stringify({ amount: 1200, source: PAN })
    );
    await new Promise((r) => setTimeout(r, 30));
    attrs = serverRecordFor('/writehead/charges');
  });

  it('captures the response body and redacts it at source', () => {
    const resBody = attrs['flanj.http.response.body'] as string;
    expect(resBody).toContain('⟦REDACTED:EMAIL⟧');
    expect(resBody).toContain('"ok":true');
    expect(resBody).not.toContain(RESPONSE_EMAIL);
  });

  it('derives the response content type from the writeHead headers', () => {
    expect(attrs['flanj.http.response.content_type']).toBe('application/json');
  });

  it('emits the writeHead response headers (lowercased, allowlisted)', () => {
    const headers = JSON.parse(attrs['flanj.http.response.headers'] as string) as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-request-id']).toBe('req_srv_wh');
  });

  it('still redacts the request body and leaves no raw PAN on the row', () => {
    expect(attrs['flanj.http.request.body']).toContain('⟦REDACTED:PAN⟧');
    expect(attrs['flanj.redaction.applied']).toBe(true);
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });

  it('does not disturb the app: its handler still read the full raw body', () => {
    expect(handlerBodies['/writehead/charges']).toContain(PAN);
  });
});

/**
 * The other two header shapes `writeHead` accepts, plus the compression-middleware
 * shape where the teed response bytes are gzip on the wire.
 */
describe.each([
  ['writeHead(code, reason, headers)', '/writehead/reason'],
  ['writeHead(code, flat header array)', '/writehead/flat-array'],
  ['writeHead(code, headers) behind gzip compression', '/writehead/gzip']
])('ingress (server) capture — %s', (_form, path) => {
  let attrs: Record<string, unknown>;

  beforeAll(async () => {
    await driveCall(
      path,
      { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      JSON.stringify({ amount: 1200, source: PAN })
    );
    await new Promise((r) => setTimeout(r, 30));
    attrs = serverRecordFor(path);
  });

  it('recovers the content type and captures a redacted response body', () => {
    expect(attrs['flanj.http.response.content_type']).toBe('application/json');
    const resBody = attrs['flanj.http.response.body'] as string;
    expect(resBody).toContain('"ok":true');
    expect(resBody).toContain('⟦REDACTED:EMAIL⟧');
    expect(resBody).not.toContain(RESPONSE_EMAIL);
  });

  it('leaves no raw PAN on the row', () => {
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });
});

/**
 * The header is believed only from the trusted proxy, and only the hop the
 * proxy appended counts. Each row is one call the loopback "proxy" forwards
 * with the chain a real proxy would present.
 */
describe.each([
  {
    name: 'an INTERNAL caller behind the proxy claiming a public identity (exploit (b))',
    path: '/spoof/public-from-inside',
    xff: '203.0.113.7, 192.168.1.20',
    peerHost: '192.168.1.20',
    edgeClass: 'internal'
  },
  {
    name: 'a two-tier proxy chain: the edge LB hop is walked past, the leftmost is never taken',
    path: '/spoof/two-tier',
    xff: '198.51.100.4, 203.0.113.7, 172.16.5.5',
    peerHost: '203.0.113.7',
    edgeClass: 'external'
  },
  {
    name: 'a chain made only of trusted hops: the request originated inside the proxy tier',
    path: '/spoof/all-trusted',
    xff: '172.16.5.5',
    peerHost: '172.16.5.5',
    edgeClass: 'internal'
  },
  {
    name: 'a hostname hop (a proxy forwarding a name, as the e2e consumers do) is kept verbatim',
    path: '/spoof/hostname-hop',
    xff: '10.0.0.1, api.consumer-a.test',
    peerHost: 'api.consumer-a.test',
    edgeClass: 'external'
  }
])('ingress (server) capture — $name', ({ path, xff, peerHost, edgeClass }) => {
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

  it(`classifies the caller as ${peerHost} (${edgeClass})`, () => {
    expect(attrs['flanj.peer.host']).toBe(peerHost);
    expect(attrs['flanj.edge.class']).toBe(edgeClass);
    expect(attrs['flanj.capture.bodies']).toBe(edgeClass === 'external');
  });

  it(edgeClass === 'external' ? 'captures and redacts the bodies' : 'captures NO body — metadata-only', () => {
    if (edgeClass === 'external') {
      expect(attrs['flanj.http.request.body']).toContain('⟦REDACTED:PAN⟧');
      expect(attrs['flanj.http.response.body']).toContain('⟦REDACTED:EMAIL⟧');
    } else {
      expect(attrs['flanj.http.request.body']).toBe('');
      expect(attrs['flanj.http.response.body']).toBe('');
    }
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });

  it('still lets the app read the full raw body', () => {
    expect(handlerBodies[path]).toContain(PAN);
  });
});

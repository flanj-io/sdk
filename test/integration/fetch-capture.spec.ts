import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type FlanjHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';
import { bundledAgentClass, installLoopbackGlobalDispatcher } from '../support/loopback-fetch';

/**
 * Global `fetch()` — Node's bundled undici — captured like `node:http`: the same
 * record shape (CONTRACTS §2), the same redaction floor, the same caps, gates,
 * ignores and content-encoding handling. undici has its own socket path, so
 * before this every `fetch()` produced a healthy startup line and zero rows.
 *
 * The in-process server below is dialled as `api.acme.test` (an EXTERNAL name,
 * so bodies are captured) through a loopback-resolving Agent installed as the
 * global dispatcher before `start()` — see `test/support/loopback-fetch.ts`.
 */

const PAN = '4111111111111111'; // valid-Luhn test Visa
const EMAIL = 'jane@acme.test';
const CUSTOMER = JSON.stringify({ id: 'cus_1', email: EMAIL, card: { number: PAN }, amount: 1200 });
const CHARGE = JSON.stringify({ id: 'ch_1Mox', object: 'charge', amount: '1200', currency: 'usd' });
const BODY_CAP = 16384;
const IGNORED_PATH = '/v1/health-ignored';

const golden = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/golden-otlp-call.json'), 'utf8')) as {
  resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string }[] }[] }[] }[];
};

interface FixtureCase {
  id: string;
  kind: 'json' | 'text';
  input: unknown;
  expected: unknown;
  patterns: string[];
  fields?: unknown[];
}
const fixtures = (
  JSON.parse(readFileSync(resolve(__dirname, '../../contracts/redaction-fixtures.json'), 'utf8')) as {
    cases: FixtureCase[];
  }
).cases;

let server: Server;
let base: string;
let internalBase: string;
let handle: FlanjHandle;
let restoreDispatcher: () => void;
let savedIgnore: string | undefined;
const exporter = new InMemoryLogExporter();
/** What the server actually received per path — proves the socket bytes were not altered. */
const received = new Map<string, Buffer>();

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '/';
      received.set(url, body);
      if (url.startsWith('/fx/')) {
        // Redaction-fixture echo: the same payload comes back as the response.
        res.setHeader('content-type', req.headers['content-type'] ?? 'application/json');
        res.end(body);
        return;
      }
      res.setHeader('content-type', 'application/json');
      switch (url) {
        case '/v1/charges':
          res.setHeader('x-request-id', 'req_0Vy9aX2bK');
          res.end(CHARGE);
          return;
        case '/v1/redirect':
          res.statusCode = 302;
          res.setHeader('location', '/v1/final');
          res.end('{"moved":true}');
          return;
        case '/v1/gzip':
          res.setHeader('content-encoding', 'gzip');
          res.end(gzipSync(Buffer.from(CUSTOMER)));
          return;
        case '/v1/brotli':
          res.setHeader('content-encoding', 'br');
          res.end(brotliCompressSync(Buffer.from(CUSTOMER)));
          return;
        case '/v1/unknown-coding':
          res.setHeader('content-encoding', 'x-flanj-unknown');
          res.end(gzipSync(Buffer.from(CUSTOMER)));
          return;
        case '/v1/big':
          res.end(JSON.stringify({ email: EMAIL, pad: 'x'.repeat(BODY_CAP * 2) }));
          return;
        case '/v1/reset':
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
          res.write('{"partial":');
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        default:
          res.end(CUSTOMER);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://api.acme.test:${port}`;
  internalBase = `http://127.0.0.1:${port}`;

  restoreDispatcher = installLoopbackGlobalDispatcher();
  savedIgnore = process.env.FLANJ_IGNORE_URLS;
  process.env.FLANJ_IGNORE_URLS = IGNORED_PATH;
  handle = start({
    serviceName: 'acme-consumer',
    // A spelling of the loopback server no other test dials, so the self-ignore
    // is observable: without it this endpoint would produce an internal-edge row.
    otlpEndpoint: `http://localhost:${port}/v1/logs`,
    bodyCapBytes: BODY_CAP,
    processor: new SimpleLogRecordProcessor({ exporter })
  });
});

afterAll(async () => {
  await handle.shutdown();
  restoreDispatcher();
  if (savedIgnore === undefined) delete process.env.FLANJ_IGNORE_URLS;
  else process.env.FLANJ_IGNORE_URLS = savedIgnore;
  await new Promise<void>((r) => server.close(() => r()));
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function clientRecords(target: string): Record<string, unknown>[] {
  return exporter.records
    .map((r) => r.attributes as Record<string, unknown>)
    .filter((a) => a['flanj.direction'] === 'client' && a['flanj.http.target'] === target);
}

function clientRecord(target: string): Record<string, unknown> {
  const found = clientRecords(target);
  if (found.length !== 1) throw new Error(`expected 1 client record for ${target}, got ${found.length}`);
  return found[0] as Record<string, unknown>;
}

describe('fetch GET — response body captured', () => {
  let attrs: Record<string, unknown>;
  let appBody: string;

  beforeAll(async () => {
    const res = await fetch(`${base}/v1/customers/cus_1?expand=card`);
    appBody = await res.text();
    await settle();
    attrs = clientRecord('/v1/customers/cus_1?expand=card');
  });

  it('does not disturb the app: it reads the full, unmodified body', () => {
    expect(appBody).toBe(CUSTOMER);
  });

  it('records method, route, target, status and the external edge', () => {
    expect(attrs['flanj.record.type']).toBe('call');
    expect(attrs['flanj.http.method']).toBe('GET');
    expect(attrs['flanj.http.route']).toBe('/v1/customers/cus_1');
    expect(attrs['flanj.http.status_code']).toBe(200);
    expect(attrs['flanj.peer.host']).toBe(new URL(base).host);
    expect(attrs['flanj.edge.class']).toBe('external');
    expect(attrs['flanj.capture.bodies']).toBe(true);
    expect(attrs['flanj.http.url.full']).toBe(`${base}/v1/customers/cus_1?expand=card`);
  });

  it('redacts the response body at source and reports what fired', () => {
    const body = attrs['flanj.http.response.body'] as string;
    expect(body).toContain('⟦REDACTED:EMAIL⟧');
    expect(body).toContain('⟦REDACTED:PAN⟧');
    expect(body).toContain('"id":"cus_1"');
    expect(attrs['flanj.http.response.content_type']).toBe('application/json');
    expect(JSON.parse(attrs['flanj.redaction.patterns'] as string)).toEqual(['PAN', 'EMAIL']);
    expect(JSON.stringify(attrs)).not.toContain(PAN);
    expect(JSON.stringify(attrs)).not.toContain(EMAIL);
  });
});

describe('fetch POST with a JSON body', () => {
  let attrs: Record<string, unknown>;
  let appBody: string;
  const requestBody = JSON.stringify({ amount: 1200, currency: 'usd', source: PAN });

  beforeAll(async () => {
    const ctx = trace.setSpanContext(context.active(), {
      traceId: '5b8efff798038103d269b633813fc60c',
      spanId: 'eee19b7ec3c1b174',
      traceFlags: 1
    });
    appBody = await context.with(ctx, async () => {
      const res = await fetch(`${base}/v1/charges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem_9f2c1a',
          authorization: 'Bearer sk_live_do_not_leak'
        },
        body: requestBody
      });
      return res.text();
    });
    await settle();
    attrs = clientRecord('/v1/charges');
  });

  it('sends exactly the bytes the app gave fetch, and the app reads the full response', () => {
    expect(received.get('/v1/charges')?.toString('utf8')).toBe(requestBody);
    expect(appBody).toBe(CHARGE);
  });

  it('emits every required flanj.* attribute key from the golden record (the golden call is a POST with both bodies)', () => {
    const rec = golden.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    for (const { key } of rec?.attributes ?? []) expect(attrs, `missing ${key}`).toHaveProperty(key);
  });

  it('captures the request body, redacted', () => {
    expect(attrs['flanj.http.method']).toBe('POST');
    expect(attrs['flanj.http.request.content_type']).toBe('application/json');
    const body = attrs['flanj.http.request.body'] as string;
    expect(JSON.parse(body)).toEqual({ amount: 1200, currency: 'usd', source: '⟦REDACTED:PAN⟧' });
    expect(attrs['flanj.http.request.body.truncated']).toBe(false);
    expect(attrs['flanj.http.response.body']).toBe(CHARGE);
  });

  it('carries correlation keys from both directions and the active span', () => {
    expect(attrs['flanj.corr.request_id']).toBe('req_0Vy9aX2bK');
    expect(attrs['flanj.corr.idempotency_key']).toBe('idem_9f2c1a');
    expect(attrs['flanj.corr.trace_id']).toBe('5b8efff798038103d269b633813fc60c');
    expect(attrs['flanj.corr.span_id']).toBe('eee19b7ec3c1b174');
  });

  it('never emits a credential header raw', () => {
    expect(JSON.stringify(attrs)).not.toContain('sk_live_do_not_leak');
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });
});

describe('fetch POST with a streamed body', () => {
  let attrs: Record<string, unknown>;
  const parts = ['{"amount":1200,', `"source":"${PAN}",`, `"email":"${EMAIL}"}`];

  beforeAll(async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(encoder.encode(p));
        controller.close();
      }
    });
    const res = await fetch(`${base}/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half'
    } as RequestInit);
    await res.text();
    await settle();
    attrs = clientRecord('/v1/uploads');
  });

  it('the server received every streamed byte, in order, unaltered', () => {
    expect(received.get('/v1/uploads')?.toString('utf8')).toBe(parts.join(''));
  });

  it('tees the stream into the record, redacted', () => {
    const body = JSON.parse(attrs['flanj.http.request.body'] as string) as Record<string, unknown>;
    expect(body).toEqual({ amount: 1200, source: '⟦REDACTED:PAN⟧', email: '⟦REDACTED:EMAIL⟧' });
  });
});

describe('fetch request bodies of every BodyInit shape', () => {
  it.each([
    ['URLSearchParams', () => new URLSearchParams({ email: EMAIL, amount: '1200' }), 'application/x-www-form-urlencoded'],
    ['Uint8Array', () => new TextEncoder().encode(JSON.stringify({ email: EMAIL })), 'application/json'],
    ['Blob', () => new Blob([JSON.stringify({ email: EMAIL })], { type: 'application/json' }), 'application/json']
  ])('%s', async (name, makeBody, contentType) => {
    const target = `/v1/shapes/${name}`;
    const headers = name === 'URLSearchParams' || name === 'Blob' ? undefined : { 'content-type': contentType };
    const res = await fetch(`${base}${target}`, { method: 'POST', body: makeBody(), headers });
    await res.text();
    await settle();
    const attrs = clientRecord(target);
    expect(String(attrs['flanj.http.request.content_type'])).toContain(contentType);
    expect(attrs['flanj.http.request.body']).toContain('REDACTED:EMAIL');
    expect(JSON.stringify(attrs)).not.toContain(EMAIL);
    expect(received.get(target)?.toString('utf8')).toContain(name === 'URLSearchParams' ? 'jane%40acme.test' : EMAIL);
  });

  it('FormData is multipart: sent untouched, no body captured', async () => {
    const form = new FormData();
    form.set('email', EMAIL);
    const res = await fetch(`${base}/v1/shapes/form-data`, { method: 'POST', body: form });
    await res.text();
    await settle();
    const attrs = clientRecord('/v1/shapes/form-data');
    expect(String(attrs['flanj.http.request.content_type'])).toContain('multipart/form-data');
    expect(attrs['flanj.http.request.body']).toBe('');
    expect(received.get('/v1/shapes/form-data')?.toString('utf8')).toContain(EMAIL);
  });
});

describe('fetch errors', () => {
  it('a refused connection rejects exactly as without the SDK, and records nothing', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));

    const err = await fetch(`http://api.acme.test:${port}/v1/refused`).then(
      () => undefined,
      (e: unknown) => e as TypeError & { cause?: { code?: string } }
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err?.cause?.code).toBe('ECONNREFUSED');
    await settle();
    expect(clientRecords('/v1/refused')).toHaveLength(0);
  });

  it('a response cut mid-body rejects the reader, records nothing, and the next call is still captured', async () => {
    const res = await fetch(`${base}/v1/reset`);
    await expect(res.text()).rejects.toThrow();
    await settle();
    expect(clientRecords('/v1/reset')).toHaveLength(0);

    const next = await fetch(`${base}/v1/after-reset`);
    await next.text();
    await settle();
    expect(clientRecords('/v1/after-reset')).toHaveLength(1);
  });
});

describe('fetch following a redirect', () => {
  let appBody: string;
  let finalUrl: string;

  beforeAll(async () => {
    const res = await fetch(`${base}/v1/redirect`);
    finalUrl = res.url;
    appBody = await res.text();
    await settle();
  });

  it('the app lands on the final URL with its body', () => {
    expect(finalUrl).toBe(`${base}/v1/final`);
    expect(appBody).toBe(CUSTOMER);
  });

  it('records each hop fetch made on the wire: the 302, then the final call', () => {
    const hop = clientRecord('/v1/redirect');
    expect(hop['flanj.http.status_code']).toBe(302);
    const final = clientRecord('/v1/final');
    expect(final['flanj.http.status_code']).toBe(200);
    expect(final['flanj.http.response.body']).toContain('⟦REDACTED:PAN⟧');
  });
});

describe.each([
  ['gzip', '/v1/gzip'],
  ['br', '/v1/brotli']
])('fetch of a %s-encoded response', (coding, target) => {
  let attrs: Record<string, unknown>;
  let appBody: string;

  beforeAll(async () => {
    const res = await fetch(`${base}${target}`);
    appBody = await res.text();
    await settle();
    attrs = clientRecord(target);
  });

  it('the app still gets the decoded body fetch always gave it', () => {
    expect(appBody).toBe(CUSTOMER);
  });

  it('stores the DECODED payload, tokenised — never the compressed frame', () => {
    const body = attrs['flanj.http.response.body'] as string;
    expect(body).toContain('⟦REDACTED:EMAIL⟧');
    expect(body).toContain('⟦REDACTED:PAN⟧');
    expect(attrs['flanj.redaction.applied']).toBe(true);
    const headers = JSON.parse(attrs['flanj.http.response.headers'] as string) as Record<string, string>;
    expect(headers['content-encoding']).toBe(coding);
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });
});

describe('fetch of a response in a coding the SDK cannot undo', () => {
  it('keeps NO body rather than an unscanned frame', async () => {
    const res = await fetch(`${base}/v1/unknown-coding`);
    await res.arrayBuffer();
    await settle();
    const attrs = clientRecord('/v1/unknown-coding');
    expect(attrs['flanj.http.response.body']).toBe('');
    expect(attrs['flanj.redaction.applied']).toBe(false);
  });
});

describe('fetch caps, gates and ignores', () => {
  it('truncates a response body at the cap while the app reads all of it', async () => {
    const res = await fetch(`${base}/v1/big`);
    const text = await res.text();
    await settle();
    expect(text.length).toBeGreaterThan(BODY_CAP * 2);
    const attrs = clientRecord('/v1/big');
    expect(attrs['flanj.http.response.body.truncated']).toBe(true);
    expect(Buffer.byteLength(attrs['flanj.http.response.body'] as string)).toBeLessThanOrEqual(BODY_CAP + 64);
    expect(JSON.stringify(attrs)).not.toContain(EMAIL);
  });

  it('a call to an FLANJ_IGNORE_URLS match is made but never captured', async () => {
    const res = await fetch(`${base}${IGNORED_PATH}`);
    expect(await res.text()).toBe(CUSTOMER);
    await settle();
    expect(clientRecords(IGNORED_PATH)).toHaveLength(0);
  });

  it("the SDK's own OTLP endpoint is ignored even when dialled through fetch", async () => {
    const res = await fetch(handle.endpoint, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    await res.text();
    await settle();
    const path = new URL(handle.endpoint).pathname;
    expect(clientRecords(path)).toHaveLength(0);
  });

  it('an internal edge is metadata-only: the record exists, no body was teed', async () => {
    const res = await fetch(`${internalBase}/v1/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: PAN })
    });
    expect(await res.text()).toBe(CUSTOMER);
    await settle();
    const attrs = clientRecord('/v1/internal');
    expect(attrs['flanj.edge.class']).toBe('internal');
    expect(attrs['flanj.capture.bodies']).toBe(false);
    expect(attrs['flanj.http.request.body']).toBe('');
    expect(attrs['flanj.http.response.body']).toBe('');
    expect(received.get('/v1/internal')?.toString('utf8')).toBe(JSON.stringify({ source: PAN }));
  });

  it('a fetch given its own dispatcher is outside the global hook (the documented edge)', async () => {
    const Agent = bundledAgentClass();
    const res = await fetch(`${internalBase}/v1/own-dispatcher`, { dispatcher: new Agent() } as RequestInit);
    await res.text();
    await settle();
    expect(clientRecords('/v1/own-dispatcher')).toHaveLength(0);
  });
});

describe('redaction-fixtures.json applied to fetch-captured bodies (both directions)', () => {
  const results = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    for (const c of fixtures) {
      const body = c.kind === 'json' ? JSON.stringify(c.input) : (c.input as string);
      const contentType = c.kind === 'json' ? 'application/json' : 'text/plain; charset=utf-8';
      const res = await fetch(`${base}/fx/${c.id}`, { method: 'POST', headers: { 'content-type': contentType }, body });
      await res.arrayBuffer();
    }
    await settle();
    for (const c of fixtures) results.set(c.id, clientRecord(`/fx/${c.id}`));
  }, 60_000);

  it('ran every fixture', () => {
    expect(fixtures.length).toBeGreaterThan(50);
    expect(results.size).toBe(fixtures.length);
  });

  it.each(fixtures.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const attrs = results.get(c.id) as Record<string, unknown>;
    for (const part of ['request', 'response'] as const) {
      const captured = attrs[`flanj.http.${part}.body`] as string;
      if (c.kind === 'json') expect(JSON.parse(captured), part).toEqual(c.expected);
      else expect(captured, part).toBe(c.expected);
    }
    expect(JSON.parse(attrs['flanj.redaction.patterns'] as string)).toEqual(c.patterns);
    const fields = attrs['flanj.redaction.fields']
      ? (JSON.parse(attrs['flanj.redaction.fields'] as string) as { part: string }[])
      : [];
    for (const part of ['request', 'response']) {
      const mine = fields.filter((f) => f.part === part).map(({ part: _p, ...rest }) => rest);
      expect(mine, `${part} fields`).toEqual(c.fields ?? []);
    }
  });
});

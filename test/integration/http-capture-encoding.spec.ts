import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ClientRequest, type RequestOptions } from 'node:http';
import { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type FlanjHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';

/**
 * EGRESS capture of CONTENT-ENCODED responses. `IncomingMessage` never
 * decompresses — axios, got and node-fetch inflate downstream, in userland — so
 * a provider honouring the default `Accept-Encoding` hands the tee gzip/brotli
 * bytes. Those must be decoded BEFORE the redaction floor runs, or the row
 * carries an unscanned payload and reports `redaction.applied=false`.
 *
 * Every route below serves the same JSON (an email + a Luhn-valid PAN) under a
 * different coding, with an identity-encoded control on the same server.
 */

const PAN = '4111111111111111'; // valid-Luhn test Visa
const EMAIL = 'jane@acme.test';
const PAYLOAD = JSON.stringify({ id: 'ch_1Mox', contact: EMAIL, source: PAN, amount: 1200 });

let server: Server;
let handle: FlanjHandle;
const exporter = new InMemoryLogExporter();

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      switch (req.url) {
        case '/v1/gzip':
          res.setHeader('content-encoding', 'gzip');
          res.end(gzipSync(Buffer.from(PAYLOAD, 'utf8')));
          break;
        case '/v1/brotli':
          res.setHeader('content-encoding', 'br');
          res.end(brotliCompressSync(Buffer.from(PAYLOAD, 'utf8')));
          break;
        case '/v1/unknown-coding':
          // A coding the SDK cannot undo (node's zlib has no zstd on this line).
          res.setHeader('content-encoding', 'zstd');
          res.end(gzipSync(Buffer.from(PAYLOAD, 'utf8')));
          break;
        default:
          // The identity-encoding control on the same provider.
          res.end(PAYLOAD);
      }
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

/**
 * Call an EXTERNAL hostname (so the edge classifies external and bodies are
 * captured) that resolves to the in-process loopback server, and return the raw
 * bytes the app itself received — still encoded, exactly as a real client
 * library gets them before it inflates.
 */
function driveCall(path: string, requestBody: string): Promise<Buffer> {
  const liveHttp = (
    process as unknown as {
      getBuiltinModule(id: string): {
        request(url: string, opts: RequestOptions, cb: (res: IncomingMessage) => void): ClientRequest;
      };
    }
  ).getBuiltinModule('node:http');
  const port = (server.address() as AddressInfo).port;
  const lookup = ((_hostname: string, opts: { all?: boolean }, cb: (err: null, ...rest: unknown[]) => void): void => {
    if (opts && opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  }) as unknown as RequestOptions['lookup'];

  return new Promise<Buffer>((resolvePromise, reject) => {
    const req = liveHttp.request(
      `http://api.acme.test:${port}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, lookup },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolvePromise(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.end(requestBody);
  });
}

function clientRecordFor(path: string): Record<string, unknown> {
  const rec = exporter.records.find(
    (r) =>
      (r.attributes as Record<string, unknown>)['flanj.direction'] === 'client' &&
      (r.attributes as Record<string, unknown>)['flanj.http.target'] === path
  );
  if (!rec) throw new Error(`no client record for ${path}`);
  return rec.attributes as Record<string, unknown>;
}

async function capture(path: string, requestBody = JSON.stringify({ amount: 1200 })): Promise<Record<string, unknown>> {
  await driveCall(path, requestBody);
  await new Promise((r) => setTimeout(r, 30));
  return clientRecordFor(path);
}

describe.each([
  ['gzip', '/v1/gzip'],
  ['brotli', '/v1/brotli']
])('egress capture of a %s-encoded response', (coding, path) => {
  let attrs: Record<string, unknown>;
  let appBytes: Buffer;

  beforeAll(async () => {
    appBytes = await driveCall(path, JSON.stringify({ amount: 1200 }));
    await new Promise((r) => setTimeout(r, 30));
    attrs = clientRecordFor(path);
  });

  it('decodes the payload and tokenises it — the row is not mangled wire bytes', () => {
    const body = attrs['flanj.http.response.body'] as string;
    expect(body).toContain('⟦REDACTED:EMAIL⟧');
    expect(body).toContain('⟦REDACTED:PAN⟧');
    expect(body).toContain('"id":"ch_1Mox"');
  });

  it('reports the redaction it actually performed', () => {
    expect(attrs['flanj.redaction.applied']).toBe(true);
    const patterns = JSON.parse(attrs['flanj.redaction.patterns'] as string) as string[];
    expect(patterns).toEqual(expect.arrayContaining(['PAN', 'EMAIL']));
  });

  it(`says the response arrived ${coding}-encoded`, () => {
    const headers = JSON.parse(attrs['flanj.http.response.headers'] as string) as Record<string, string>;
    expect(headers['content-encoding']).toBe(coding === 'brotli' ? 'br' : coding);
    expect(attrs['flanj.http.response.content_type']).toBe('application/json');
  });

  it('leaves no raw PAN or email anywhere in the emitted attributes', () => {
    const emitted = JSON.stringify(attrs);
    expect(emitted).not.toContain(PAN);
    expect(emitted).not.toContain(EMAIL);
  });

  it('does not disturb the app: it still receives the encoded bytes verbatim', () => {
    const expected = coding === 'gzip' ? gzipSync(Buffer.from(PAYLOAD, 'utf8')) : brotliCompressSync(Buffer.from(PAYLOAD, 'utf8'));
    expect(appBytes.equals(expected)).toBe(true);
  });
});

describe('egress capture — identity-encoding control on the same provider', () => {
  it('tokenises the body exactly as the compressed routes do', async () => {
    const attrs = await capture('/v1/identity');

    const body = attrs['flanj.http.response.body'] as string;
    expect(body).toContain('⟦REDACTED:EMAIL⟧');
    expect(body).toContain('⟦REDACTED:PAN⟧');
    expect(attrs['flanj.redaction.applied']).toBe(true);
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });
});

describe('egress capture — a coding the SDK cannot undo', () => {
  let attrs: Record<string, unknown>;

  beforeAll(async () => {
    attrs = await capture('/v1/unknown-coding');
  });

  it('keeps NO body rather than storing bytes the redactor never decoded', () => {
    expect(attrs['flanj.http.response.body']).toBe('');
    expect(attrs['flanj.http.response.body.truncated']).toBe(false);
  });

  it('still says what happened: the coding and content type are on the row', () => {
    const headers = JSON.parse(attrs['flanj.http.response.headers'] as string) as Record<string, string>;
    expect(headers['content-encoding']).toBe('zstd');
    expect(attrs['flanj.http.response.content_type']).toBe('application/json');
  });

  it('reports no redaction because nothing was captured to redact', () => {
    expect(attrs['flanj.redaction.applied']).toBe(false);
    expect(JSON.stringify(attrs)).not.toContain(PAN);
    expect(JSON.stringify(attrs)).not.toContain(EMAIL);
  });
});

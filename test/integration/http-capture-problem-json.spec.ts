import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ClientRequest, type RequestOptions } from 'node:http';
import { AddressInfo } from 'node:net';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type FlanjHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';

/**
 * RFC 6839 structured-suffix JSON on BOTH paths. A provider that rejects a call
 * answers `application/problem+json` (RFC 7807) — the standard error payload,
 * and the response most worth validating against its contract. The gate used to
 * compare the raw header against `application/json` by prefix, so that body was
 * silently dropped in both directions and the collector saw an empty response.
 *
 * One request drives both records: the egress (client) record of the call and,
 * because the in-process server sees an external `X-Forwarded-For`, the ingress
 * (server) record of the same exchange. An `application/octet-stream` reply on
 * a sibling route is the control that binary is still never captured.
 */

const PAN = '4111111111111111'; // valid-Luhn test Visa
const EMAIL = 'jane@acme.test';
const PROBLEM = JSON.stringify({
  type: 'https://api.acme.test/errors/card-declined',
  title: 'Card declined',
  status: 422,
  detail: `Issuer refused the card registered to ${EMAIL}`
});
const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';
const REQUEST_CONTENT_TYPE = 'application/vnd.api+json';

let server: Server;
let handle: FlanjHandle;
const exporter = new InMemoryLogExporter();

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      switch (req.url) {
        case '/v1/octet':
          res.setHeader('content-type', 'application/octet-stream');
          res.statusCode = 200;
          res.end(Buffer.from(PROBLEM, 'utf8'));
          break;
        default:
          res.setHeader('content-type', PROBLEM_CONTENT_TYPE);
          res.statusCode = 422;
          res.end(PROBLEM);
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
 * Call an EXTERNAL hostname (so the egress edge classifies external) that
 * resolves to the in-process loopback server, carrying an external
 * `X-Forwarded-For` so the ingress edge classifies external too. Returns the
 * body exactly as the app received it.
 */
function driveCall(path: string): Promise<{ status: number | undefined; body: string }> {
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

  return new Promise((resolvePromise, reject) => {
    const req = liveHttp.request(
      `http://api.acme.test:${port}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': REQUEST_CONTENT_TYPE, 'x-forwarded-for': '203.0.113.9' },
        lookup
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify({ data: { type: 'charge', attributes: { amount: 1200, source: PAN } } }));
  });
}

function recordFor(direction: 'client' | 'server', path: string): Record<string, unknown> {
  const rec = exporter.records.find(
    (r) =>
      (r.attributes as Record<string, unknown>)['flanj.direction'] === direction &&
      (r.attributes as Record<string, unknown>)['flanj.http.target'] === path
  );
  if (!rec) throw new Error(`no ${direction} record for ${path}`);
  return rec.attributes as Record<string, unknown>;
}

describe('a problem+json rejection, captured in both directions', () => {
  let app: { status: number | undefined; body: string };

  beforeAll(async () => {
    app = await driveCall('/v1/charges');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('does not disturb the app: it still reads the whole problem document', () => {
    expect(app.status).toBe(422);
    expect(JSON.parse(app.body).detail).toContain(EMAIL);
  });

  describe.each(['client', 'server'] as const)('the %s record', (direction) => {
    let attrs: Record<string, unknown>;

    beforeAll(() => {
      attrs = recordFor(direction, '/v1/charges');
    });

    it('keeps the problem+json response body, redacted at source', () => {
      const body = attrs['flanj.http.response.body'] as string;
      expect(body).toContain('⟦REDACTED:EMAIL⟧');
      expect(body).toContain('"title":"Card declined"');
      expect(body).not.toContain(EMAIL);
      expect(attrs['flanj.http.status_code']).toBe(422);
    });

    it('keeps the vnd.api+json request body, redacted at source', () => {
      const body = attrs['flanj.http.request.body'] as string;
      expect(body).toContain('⟦REDACTED:PAN⟧');
      expect(body).toContain('"type":"charge"');
    });

    it('reports the content types verbatim and the redaction it performed', () => {
      expect(attrs['flanj.http.request.content_type']).toBe(REQUEST_CONTENT_TYPE);
      expect(attrs['flanj.http.response.content_type']).toBe(PROBLEM_CONTENT_TYPE);
      expect(attrs['flanj.redaction.applied']).toBe(true);
      const patterns = JSON.parse(attrs['flanj.redaction.patterns'] as string) as string[];
      expect(patterns).toEqual(['PAN', 'EMAIL']);
    });

    it('leaves no raw PAN or email anywhere in the emitted attributes', () => {
      const emitted = JSON.stringify(attrs);
      expect(emitted).not.toContain(PAN);
      expect(emitted).not.toContain(EMAIL);
    });
  });
});

describe('the octet-stream control on the same provider', () => {
  beforeAll(async () => {
    await driveCall('/v1/octet');
    await new Promise((r) => setTimeout(r, 30));
  });

  it.each(['client', 'server'] as const)('%s record: request captured, binary response still dropped', (direction) => {
    const attrs = recordFor(direction, '/v1/octet');
    expect(attrs['flanj.http.request.body']).toContain('⟦REDACTED:PAN⟧');
    expect(attrs['flanj.http.response.body']).toBe('');
    expect(attrs['flanj.http.response.content_type']).toBe('application/octet-stream');
    expect(JSON.stringify(attrs)).not.toContain(EMAIL);
    expect(JSON.stringify(attrs)).not.toContain(PAN);
  });
});

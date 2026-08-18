import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type RequestOptions, type ClientRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type ViniferaHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';

/**
 * Regression guard for the self-feedback loop: the SDK must NOT capture requests
 * to its own OTLP exporter host. Otherwise a co-located collector turns one call
 * into an unbounded capture→export→capture storm. start() seeds ignoreUrls with
 * the exporter's host[:port]; a call to any OTHER host is still captured.
 */

let provider: Server;
let collector: Server;
let providerBase: string;
let collectorBase: string;
let handle: ViniferaHandle;
const exporter = new InMemoryLogExporter();

function ok(_req: IncomingMessage, res: import('node:http').ServerResponse): void {
  res.setHeader('content-type', 'application/json');
  res.statusCode = 200;
  res.end('{"ok":true}');
}

beforeAll(async () => {
  provider = createServer(ok);
  collector = createServer(ok);
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  providerBase = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  collectorBase = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

  // Point the OTLP endpoint at the collector server → its host[:port] is auto-ignored.
  handle = start({
    integration: 'acme-payments',
    otlpEndpoint: `${collectorBase}/v1/logs`,
    processor: new SimpleLogRecordProcessor({ exporter })
  });
});

afterAll(async () => {
  await handle.shutdown();
  await new Promise<void>((r) => provider.close(() => r()));
  await new Promise<void>((r) => collector.close(() => r()));
});

function post(url: string): Promise<void> {
  const http = (process as unknown as {
    getBuiltinModule(id: string): { request(u: string, o: RequestOptions, cb: (r: IncomingMessage) => void): ClientRequest };
  }).getBuiltinModule('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.end('{"amount":1200}');
  });
}

describe('ignoreUrls — no self-capture of the OTLP exporter host', () => {
  it('captures a normal provider call but NOT a call to the exporter host', async () => {
    await post(`${collectorBase}/v1/logs`); // simulates the SDK's own export POST → must be ignored
    await post(`${providerBase}/v1/charges`); // a real provider call → must be captured
    await new Promise((r) => setTimeout(r, 20));

    // Exactly one record: the provider call. The self-export POST was ignored
    // (otherwise this would be ≥2 and a co-located collector would loop forever).
    expect(exporter.records.length).toBe(1);
    const url = exporter.records[0].attributes['vinifera.http.url.full'] as string;
    // The IP host is redacted (optional IP tier), but the port survives — match on it.
    expect(url).toContain(`:${(provider.address() as AddressInfo).port}/v1/charges`);
    expect(url).not.toContain(`:${(collector.address() as AddressInfo).port}/`);
  });
});

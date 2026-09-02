import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { start, type FlanjHandle } from '../../src/index';

/**
 * The silent-404 bug, end to end.
 *
 * `new OTLPLogExporter({ url })` uses the url VERBATIM — OTel appends `v1/logs`
 * only on the OTEL_EXPORTER_OTLP_ENDPOINT env path. So `http://localhost:4318`
 * POSTed to `/`, the collector answered 404, and with no diag logger registered
 * that was zero rows, zero stderr and exit 0. Both halves are asserted here:
 * the base URL is normalized, and a failing export is no longer silent.
 */

interface FakeCollector {
  base: string;
  /** Request paths the collector was POSTed to. */
  paths: string[];
  close: () => Promise<void>;
}

async function startCollector(status: number): Promise<FakeCollector> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? '');
    req.on('data', () => {});
    req.on('end', () => {
      res.statusCode = status;
      res.end(status === 200 ? '{}' : 'not found');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    paths,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

let handle: FlanjHandle | undefined;
let collector: FakeCollector | undefined;

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  await collector?.close();
  collector = undefined;
});

describe('start() → OTLP logs endpoint', () => {
  it('normalizes a BASE url so the collector is POSTed at /v1/logs, not /', async () => {
    collector = await startCollector(200);

    // The natural wrong guess: a base URL, as the sibling FLANJ_STORE_ENDPOINT takes.
    handle = start({ integration: 'acme-payments', otlpEndpoint: collector.base });
    expect(handle.endpoint).toBe(`${collector.base}/v1/logs`);

    handle.loggerProvider.getLogger('test').emit({ body: 'a record' });
    await handle.flush();

    expect(collector.paths).toEqual(['/v1/logs']);
  });

  it('leaves an explicit path alone', async () => {
    collector = await startCollector(200);

    handle = start({ otlpEndpoint: `${collector.base}/ingest/v1/logs` });
    expect(handle.endpoint).toBe(`${collector.base}/ingest/v1/logs`);

    handle.loggerProvider.getLogger('test').emit({ body: 'a record' });
    await handle.flush();

    expect(collector.paths).toEqual(['/ingest/v1/logs']);
  });

  it('warns ONCE on stderr, carrying the status code, when the collector 404s', async () => {
    collector = await startCollector(404);

    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        written.push(String(chunk));
        return true;
      });

    try {
      handle = start({ otlpEndpoint: `${collector.base}/wrong-path` });

      handle.loggerProvider.getLogger('test').emit({ body: 'first' });
      await handle.flush();
      handle.loggerProvider.getLogger('test').emit({ body: 'second' });
      await handle.flush();
    } finally {
      spy.mockRestore();
    }

    const warnings = written.filter((line) => line.includes('[flanj]'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('HTTP 404');
    expect(warnings[0]).toContain(`${collector.base}/wrong-path`);
    // The 404 hint points at the path the user is missing.
    expect(warnings[0]).toContain('/v1/logs');
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, FetchBodyCaptureInstrumentation, type FlanjHandle } from '../../src/index';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';
import {
  currentGlobalDispatcher,
  installLoopbackGlobalDispatcher,
  setGlobalDispatcherForTest
} from '../support/loopback-fetch';

/**
 * The fetch layer's lifecycle: one live layer per process, a clean unwrap on
 * shutdown, stacking under a later interceptor instead of tearing it out, and
 * never breaking the app when capture itself fails.
 */

let server: Server;
let url: string;
let restoreDispatcher: () => void;
const handles: FlanjHandle[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://api.acme.test:${(server.address() as AddressInfo).port}/v1/ping`;
  restoreDispatcher = installLoopbackGlobalDispatcher();
});

afterEach(async () => {
  for (const h of handles.splice(0)) await h.shutdown();
});

afterAll(async () => {
  restoreDispatcher();
  await new Promise<void>((r) => server.close(() => r()));
});

function startWith(exporter: InMemoryLogExporter): FlanjHandle {
  const handle = start({ serviceName: 'lifecycle', processor: new SimpleLogRecordProcessor({ exporter }) });
  handles.push(handle);
  return handle;
}

async function ping(): Promise<void> {
  const res = await fetch(url);
  await res.text();
  await new Promise((r) => setTimeout(r, 20));
}

const clientRows = (e: InMemoryLogExporter): number =>
  e.records.filter((r) => (r.attributes as Record<string, unknown>)['flanj.direction'] === 'client').length;

describe('fetch capture lifecycle', () => {
  it('shutdown() puts back exactly the dispatcher it composed onto', async () => {
    const before = currentGlobalDispatcher();
    const handle = startWith(new InMemoryLogExporter());
    expect(handle.fetchInstrumentation.isCapturing()).toBe(true);
    expect(currentGlobalDispatcher()).not.toBe(before);

    await handle.shutdown();
    handles.length = 0;
    expect(currentGlobalDispatcher()).toBe(before);
    expect(handle.fetchInstrumentation.isCapturing()).toBe(false);
  });

  it('a second start() in the same process installs no second layer: one row per call', async () => {
    const first = new InMemoryLogExporter();
    const second = new InMemoryLogExporter();
    const a = startWith(first);
    const b = startWith(second);
    expect(a.fetchInstrumentation.isCapturing()).toBe(true);
    expect(b.fetchInstrumentation.isCapturing()).toBe(false);

    await ping();
    expect(clientRows(first)).toBe(1);
    expect(clientRows(second)).toBe(0);
  });

  it('a start() after the live one shut down takes over', async () => {
    const first = startWith(new InMemoryLogExporter());
    await first.shutdown();
    handles.length = 0;

    const exporter = new InMemoryLogExporter();
    const next = startWith(exporter);
    expect(next.fetchInstrumentation.isCapturing()).toBe(true);
    await ping();
    expect(clientRows(exporter)).toBe(1);
  });

  it('stacks under an interceptor composed after it, and goes inert (not removed) when disabled', async () => {
    const exporter = new InMemoryLogExporter();
    const handle = startWith(exporter);
    const ours = currentGlobalDispatcher() as unknown as {
      compose: (i: (d: (o: unknown, h: unknown) => unknown) => (o: unknown, h: unknown) => unknown) => never;
    };
    let seenByLater = 0;
    const later = ours.compose((dispatch) => (opts, handler) => {
      seenByLater += 1;
      return dispatch(opts, handler);
    });
    setGlobalDispatcherForTest(later);

    await ping();
    expect(seenByLater).toBe(1);
    expect(clientRows(exporter)).toBe(1);

    await handle.shutdown();
    handles.length = 0;
    // Ours is buried: removing it would drop the later interceptor too, so it stays, inert.
    expect(currentGlobalDispatcher()).toBe(later);
    await ping();
    expect(seenByLater).toBe(2);
    expect(clientRows(exporter)).toBe(1);
  });

  it('a capture sink that throws never reaches the app', async () => {
    const instrumentation = new FetchBodyCaptureInstrumentation({
      onCapture: () => {
        throw new Error('sink exploded');
      }
    });
    try {
      expect(instrumentation.isCapturing()).toBe(true);
      const res = await fetch(url);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      instrumentation.disable();
    }
  });

  it('stacks on a global dispatcher the app installed BEFORE start(), which keeps running and comes back on shutdown', async () => {
    const loopback = currentGlobalDispatcher() as unknown as {
      compose: (i: (d: (o: unknown, h: unknown) => unknown) => (o: unknown, h: unknown) => unknown) => never;
    };
    let seenByApp = 0;
    // The app's own dispatcher: an agent with its own interceptor (a proxy or
    // retry agent has the same shape), installed as the global before the SDK.
    const appDispatcher = loopback.compose((dispatch) => (opts, handler) => {
      seenByApp += 1;
      return dispatch(opts, handler);
    });
    setGlobalDispatcherForTest(appDispatcher);
    try {
      const exporter = new InMemoryLogExporter();
      const handle = startWith(exporter);
      await ping();
      expect(seenByApp).toBe(1);
      expect(clientRows(exporter)).toBe(1);

      await handle.shutdown();
      handles.length = 0;
      expect(currentGlobalDispatcher()).toBe(appDispatcher);
    } finally {
      setGlobalDispatcherForTest(loopback as never);
    }
  });

  it('stacks on a global dispatcher that has no compose() (the fallback view), unchanged underneath', async () => {
    const loopback = currentGlobalDispatcher() as unknown as {
      dispatch: (o: unknown, h: unknown) => unknown;
    };
    let seenByPlain = 0;
    const plain = {
      dispatch(opts: unknown, handler: unknown): unknown {
        seenByPlain += 1;
        return loopback.dispatch(opts, handler);
      }
    };
    setGlobalDispatcherForTest(plain);
    try {
      const exporter = new InMemoryLogExporter();
      const handle = startWith(exporter);
      expect(handle.fetchInstrumentation.isCapturing()).toBe(true);
      expect(currentGlobalDispatcher()).not.toBe(plain);
      await ping();
      expect(seenByPlain).toBe(1);
      expect(clientRows(exporter)).toBe(1);

      await handle.shutdown();
      handles.length = 0;
      expect(currentGlobalDispatcher()).toBe(plain);
    } finally {
      setGlobalDispatcherForTest(loopback as never);
    }
  });
});

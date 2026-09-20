import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { start, type FlanjHandle } from '../index';
import { SILENCE_ENV, resetCaptureWarningsForTests } from '../capture-warning';

/**
 * `handle.instrumentMcp(client)` — the explicit counterpart of the register
 * entry's auto-instrumentation, and the TypeScript twin of the Python SDK's
 * `handle.instrument(session)`.
 *
 * Before it existed, an app that called `start()` itself had to reach into the
 * handle for a logger the handle did not expose and hand it to
 * `instrumentMcpClient` — so in practice MCP records were emitted through a
 * second, unflushed logger, or not at all.
 */

/** Records stay in the process. (`test/support` is outside this project's rootDir.) */
class InMemoryLogExporter implements LogRecordExporter {
  readonly records: ReadableLogRecord[] = [];

  export(logs: ReadableLogRecord[], resultCallback: (result: { code: number }) => void): void {
    this.records.push(...logs);
    resultCallback({ code: 0 });
  }

  async forceFlush(): Promise<void> {
    /* nothing buffered */
  }

  async shutdown(): Promise<void> {
    /* nothing to close */
  }
}

class FakeClient {
  transport = { url: 'https://mcp.acme.test/mcp' };

  getServerVersion(): { name: string; version: string } {
    return { name: 'acme-payments-mcp', version: '3.2.0' };
  }

  async listTools(): Promise<{ tools: unknown[] }> {
    return { tools: [{ name: 'get_balance' }] };
  }

  async callTool(_params: { name: string; arguments?: unknown }): Promise<unknown> {
    return { structuredContent: { balance: '1200' }, isError: false };
  }
}

let handle: FlanjHandle | undefined;
let exporter: InMemoryLogExporter;

beforeEach(() => {
  resetCaptureWarningsForTests();
  exporter = new InMemoryLogExporter();
  handle = start({
    serviceName: 'acme-agent',
    processor: new SimpleLogRecordProcessor({ exporter })
  });
});

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  delete process.env[SILENCE_ENV];
});

function attributesOf(index: number): Record<string, unknown> {
  return (exporter.records[index]?.attributes ?? {}) as Record<string, unknown>;
}

describe('handle.instrumentMcp', () => {
  it('emits MCP records through the handle’s own logger, with no logger passed in', async () => {
    const client = new FakeClient();
    handle!.instrumentMcp(client);

    const result = await client.callTool({ name: 'get_balance', arguments: { account_id: 'acct_1' } });

    expect(result).toEqual({ structuredContent: { balance: '1200' }, isError: false });
    expect(exporter.records.length, 'the call produced no record on the handle’s logger').toBe(1);
    const attributes = attributesOf(0);
    expect(attributes['flanj.record.type']).toBe('call');
    expect(attributes['flanj.mcp.tool.name']).toBe('get_balance');
    expect(attributes['flanj.peer.host']).toBe('mcp.acme.test');
  });

  it('carries the handle’s body cap, and lets an explicit option win', async () => {
    await handle!.shutdown();
    exporter = new InMemoryLogExporter();
    handle = start({
      serviceName: 'acme-agent',
      bodyCapBytes: 4,
      processor: new SimpleLogRecordProcessor({ exporter })
    });
    expect(handle.bodyCapBytes).toBe(4);

    const capped = new FakeClient();
    handle.instrumentMcp(capped);
    await capped.callTool({ name: 'get_balance', arguments: { account_id: 'a-long-account-identifier' } });
    expect(String(attributesOf(0)['flanj.http.request.body'] ?? '').length).toBeLessThanOrEqual(4);

    const uncapped = new FakeClient();
    handle.instrumentMcp(uncapped, { bodyCapBytes: 4096 });
    await uncapped.callTool({ name: 'get_balance', arguments: { account_id: 'a-long-account-identifier' } });
    expect(String(attributesOf(1)['flanj.http.request.body'] ?? '')).toContain('a-long-account-identifier');
  });

  it('snapshots tools/list through the same logger', async () => {
    const client = new FakeClient();
    handle!.instrumentMcp(client);
    await client.listTools();

    expect(exporter.records.length).toBe(1);
    expect(attributesOf(0)['flanj.record.type']).toBe('contract_snapshot');
  });
});

describe('a capture failure inside the MCP wrapper', () => {
  it('says so once on stderr and still returns the call\u2019s own result', async () => {
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const client = new FakeClient();
      handle!.instrumentMcp(client, {
        onCapture: () => {
          throw new TypeError('sink exploded');
        }
      });

      const first = await client.callTool({ name: 'get_balance', arguments: {} });
      // Pass-through is the guarantee that must survive a broken capture path.
      expect(first).toEqual({ structuredContent: { balance: '1200' }, isError: false });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        '[flanj] capturing an MCP tool call failed and capture has stopped for it: ' +
          'TypeError: sink exploded. Your application is unaffected; this is the only warning. ' +
          'Set FLANJ_SILENCE_CAPTURE_WARNINGS=1 to silence it.\n'
      );

      // Once, not per call: a failing capture path fails on every call.
      await client.callTool({ name: 'get_balance', arguments: {} });
      expect(lines).toHaveLength(1);
    } finally {
      spy.mockRestore();
      void write;
    }
  });

  it('a failing tools/list snapshot names the snapshot, not the call', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const client = new FakeClient();
      handle!.instrumentMcp(client, {
        onSnapshot: () => {
          throw new Error('snapshot sink exploded');
        }
      });
      await client.listTools();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('recording an MCP contract snapshot failed and capture has stopped for it');
    } finally {
      spy.mockRestore();
    }
  });

  it('FLANJ_SILENCE_CAPTURE_WARNINGS keeps stderr clean', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      process.env[SILENCE_ENV] = '1';
      const client = new FakeClient();
      handle!.instrumentMcp(client, {
        onCapture: () => {
          throw new Error('sink exploded');
        }
      });
      await client.callTool({ name: 'get_balance', arguments: {} });
      expect(lines).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

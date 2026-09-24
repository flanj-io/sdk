import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { start, type FlanjHandle } from '../../src/index';
import { instrumentMcpClient } from '../../src/mcp/instrument-mcp-client';
import { patchMcpClientConstructor } from '../../src/mcp/auto-instrument';
import { clearMcpEndpoints } from '../../src/instrumentation/mcp-endpoints';
import type { McpCapturedCall } from '../../src/mcp/mcp-types';
import { InMemoryLogExporter } from '../support/in-memory-log-exporter';
import { installLoopbackGlobalDispatcher } from '../support/loopback-fetch';

/**
 * An MCP client's streamable-HTTP transport speaks JSON-RPC over `fetch()`.
 * Once `fetch()` was captured, every request that transport made was recorded
 * twice: as the MCP call it is, and again as a REST call to `POST /mcp` with no
 * contract, which nothing can check and which listed the MCP server as a REST
 * provider missing a contract. The transport's own requests are the MCP
 * records' alone; every other request to the same host is still HTTP.
 *
 * The stand-ins below do what the real transport does on the wire: `_url` on
 * the transport, the initialize handshake inside `connect()`, a notification
 * answered 202, and one POST per request.
 */

const BALANCE = { balance: 1200, currency: 'usd' };

let server: Server;
let base: string;
let handle: FlanjHandle;
let restoreDispatcher: () => void;
const exporter = new InMemoryLogExporter();

class StandInTransport {
  readonly _url: URL;
  constructor(url: string) {
    this._url = new URL(url);
  }
  async send(message: { id?: number }): Promise<{ result?: unknown } | undefined> {
    const res = await fetch(this._url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message)
    });
    if (res.status === 202) {
      await res.arrayBuffer();
      return undefined;
    }
    return (await res.json()) as { result?: unknown };
  }
}

class StandInClient {
  transport?: StandInTransport;
  async connect(transport: StandInTransport): Promise<void> {
    this.transport = transport;
    await transport.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} } as never);
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
  }
  async callTool(params: { name: string; arguments?: unknown }): Promise<unknown> {
    const res = await this.transport!.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params } as never);
    return res?.result;
  }
  async listTools(): Promise<unknown> {
    const res = await this.transport!.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' } as never);
    return res?.result;
  }
  getServerVersion(): { name: string; version: string } {
    return { name: 'acme-tools-mcp', version: '1.2.0' };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      res.setHeader('content-type', 'application/json');
      if (path?.startsWith('/mcp') && req.method === 'POST' && !path.startsWith('/mcp-admin')) {
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { id?: number; method?: string };
        if (msg.id === undefined) {
          res.statusCode = 202;
          res.end();
          return;
        }
        const result =
          msg.method === 'tools/call'
            ? { content: [{ type: 'text', text: JSON.stringify(BALANCE) }], structuredContent: BALANCE }
            : msg.method === 'tools/list'
              ? { tools: [{ name: 'get_balance', inputSchema: { type: 'object' } }] }
              : { protocolVersion: '2025-06-18', serverInfo: { name: 'acme-tools-mcp', version: '1.2.0' }, capabilities: {} };
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://mcp.acme.test:${port}`;

  restoreDispatcher = installLoopbackGlobalDispatcher();
  handle = start({
    serviceName: 'acme-consumer',
    otlpEndpoint: `http://localhost:${port}/v1/logs`,
    processor: new SimpleLogRecordProcessor({ exporter })
  });
});

afterAll(async () => {
  await handle.shutdown();
  restoreDispatcher();
  clearMcpEndpoints();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  exporter.reset();
  clearMcpEndpoints();
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/** HTTP client records (never MCP ones) whose target path is exactly `path`, query aside. */
function httpRecordsFor(path: string): Record<string, unknown>[] {
  return exporter.records
    .map((r) => r.attributes as Record<string, unknown>)
    .filter(
      (a) =>
        a['flanj.direction'] === 'client' &&
        a['flanj.transport'] === undefined &&
        String(a['flanj.http.target']).split('?')[0] === path
    );
}

describe('an instrumented MCP client over streamable HTTP', () => {
  it('its handshake, notification and tool call are never HTTP records; the tool call is an MCP record', async () => {
    const captured: McpCapturedCall[] = [];
    const client = instrumentMcpClient(new StandInClient(), { onCapture: (c) => captured.push(c) });
    await client.connect(new StandInTransport(`${base}/mcp`));
    await client.listTools();
    const result = (await client.callTool({ name: 'get_balance', arguments: { account_id: 'acct_1' } })) as {
      structuredContent?: unknown;
    };
    await settle();

    expect(result.structuredContent, 'the app still reads its result').toEqual(BALANCE);
    expect(httpRecordsFor('/mcp'), 'the MCP transport is not also captured as HTTP').toEqual([]);
    expect(captured.map((c) => c.mcp.toolName)).toEqual(['get_balance']);
  });

  it('a client instrumented after it connected stops the HTTP twin from its next tool call on', async () => {
    const client = new StandInClient();
    await client.connect(new StandInTransport(`${base}/mcp-late`));
    await settle();
    // Nothing could have claimed the handshake: the SDK had not seen this client yet.
    expect(httpRecordsFor('/mcp-late')).toHaveLength(2);

    exporter.reset();
    instrumentMcpClient(client, {});
    await client.callTool({ name: 'get_balance', arguments: {} });
    await settle();
    expect(httpRecordsFor('/mcp-late')).toEqual([]);
  });

  it('the auto-instrumented client is covered from connect(), before any tool call', async () => {
    class AutoClient extends StandInClient {}
    expect(patchMcpClientConstructor(AutoClient)).toBe(true);
    const client = new AutoClient();
    await client.connect(new StandInTransport(`${base}/mcp-auto`));
    await client.callTool({ name: 'get_balance', arguments: {} });
    await settle();
    expect(httpRecordsFor('/mcp-auto')).toEqual([]);
  });

  it('every other request to the same host is still an HTTP call', async () => {
    const client = instrumentMcpClient(new StandInClient(), {});
    await client.connect(new StandInTransport(`${base}/mcp`));
    await (await fetch(`${base}/mcp-admin/status`)).text();
    await (await fetch(`${base}/v1/accounts`)).text();
    await settle();
    expect(httpRecordsFor('/mcp-admin/status')).toHaveLength(1);
    expect(httpRecordsFor('/v1/accounts')).toHaveLength(1);
  });

  it('the endpoint matches whatever query string a request carries', async () => {
    const client = instrumentMcpClient(new StandInClient(), {});
    await client.connect(new StandInTransport(`${base}/mcp?tenant=acme`));
    await (await fetch(`${base}/mcp?tenant=other`, { method: 'POST', body: '{"jsonrpc":"2.0","method":"x"}' })).text();
    await settle();
    expect(httpRecordsFor('/mcp')).toEqual([]);
  });
});

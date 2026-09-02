import { describe, it, expect, vi } from 'vitest';
import { instrumentMcpClient } from './instrument-mcp-client';
import type { McpCapturedCall, McpContractSnapshot } from './mcp-types';

/**
 * The §9 proof battery: BOTH package lines against a mock Client. The wrapper
 * never changes a call or a result (§3 "Inline anything" is a non-goal) —
 * byte-identical pass-through including thrown errors — while emitting one
 * snapshot per COMPLETE listTools and one redacted call record per callTool,
 * with honestly-labeled client-generated correlation ids.
 */

const PAN = '4242424242424242';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: { name: string; arguments?: unknown };
}

/** Mock of the `@modelcontextprotocol/sdk` 1.x Client surface. */
class MockClient1x {
  transport = {
    url: 'https://mcp.acme.test/mcp',
    sessionId: 'sess_9f3c1a',
    protocolVersion: '2025-06-18',
    sent: [] as JsonRpcMessage[],
    send(msg: JsonRpcMessage): Promise<void> {
      this.sent.push(msg);
      return Promise.resolve();
    }
  };

  fallbackNotificationHandler: ((n: unknown) => Promise<void> | void) | undefined = undefined;

  pages: { tools: unknown[]; nextCursor?: string }[] = [
    { tools: [{ name: 'get_balance', inputSchema: { type: 'object' } }], nextCursor: 'c1' },
    { tools: [{ name: 'create_refund', inputSchema: { type: 'object' } }] }
  ];
  nextResult: unknown = { content: [{ type: 'text', text: 'ok' }], isError: false };
  failNext: Error | null = null;
  failListTools: Error | null = null;
  nextId = 1;

  listToolsCalls: unknown[] = [];

  getServerVersion(): { name: string; version: string } {
    return { name: 'acme-payments-mcp', version: '3.2.0' };
  }

  getServerCapabilities(): { tools: { listChanged: boolean } } {
    return { tools: { listChanged: true } };
  }

  async listTools(params?: { cursor?: string }): Promise<{ tools: unknown[]; nextCursor?: string }> {
    this.listToolsCalls.push(params);
    if (this.failListTools) {
      const err = this.failListTools;
      this.failListTools = null;
      throw err;
    }
    const idx = params?.cursor === 'c1' ? 1 : 0;
    return this.pages[idx]!;
  }

  async callTool(params: { name: string; arguments?: unknown }): Promise<unknown> {
    // The real 1.x Client sends the JSON-RPC request through its transport.
    await this.transport.send({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return this.nextResult;
  }
}

/** Mock of the `@modelcontextprotocol/client` 2.x surface (name-first callTool, identity properties). */
class MockClient2x {
  serverInfo = { name: 'globex-fx-mcp', version: '2.0.1' };
  protocolVersion = '2026-07-28';
  nextResult: unknown = { structuredContent: { rate: 1.07 }, isError: false };

  async listTools(): Promise<{ tools: unknown[] }> {
    return { tools: [{ name: 'get_rate', inputSchema: { type: 'object' } }] };
  }

  async callTool(name: string, args?: unknown): Promise<unknown> {
    void name;
    void args;
    return this.nextResult;
  }
}

function harness1x() {
  const calls: McpCapturedCall[] = [];
  const snapshots: McpContractSnapshot[] = [];
  const client = new MockClient1x();
  instrumentMcpClient(client, {
    integration: 'acme-payments',
    onCapture: (c) => calls.push(c),
    onSnapshot: (s) => snapshots.push(s)
  });
  return { client, calls, snapshots };
}

describe('instrumentMcpClient — 1.x line: pass-through (never changes a call or a result)', () => {
  it('returns the same client instance and is idempotent', () => {
    const { client, calls } = harness1x();
    const again = instrumentMcpClient(client, { integration: 'x', onCapture: (c) => calls.push(c) });
    expect(again).toBe(client);
    return client.callTool({ name: 'get_balance', arguments: {} }).then(() => {
      expect(calls).toHaveLength(1); // double-instrumenting must not double-capture
    });
  });

  it('callTool: the result object passes through by IDENTITY, untouched', async () => {
    const { client } = harness1x();
    const result = { content: [{ type: 'text', text: 'hello' }], structuredContent: { a: 1 }, isError: false };
    client.nextResult = result;
    const got = await client.callTool({ name: 'get_balance', arguments: { account_id: 'a1' } });
    expect(got).toBe(result);
    expect(got).toEqual({ content: [{ type: 'text', text: 'hello' }], structuredContent: { a: 1 }, isError: false });
  });

  it('callTool: arguments reach the server verbatim and are never mutated', async () => {
    const { client } = harness1x();
    const args = { card_number: PAN, amount: 1200 };
    const frozen = JSON.stringify(args);
    await client.callTool({ name: 'create_refund', arguments: args });
    expect(client.transport.sent[0]!.params.arguments).toBe(args);
    expect(JSON.stringify(args)).toBe(frozen);
  });

  it('callTool: a rejection propagates with the SAME error object', async () => {
    const { client, calls } = harness1x();
    const boom = new Error('transport exploded');
    client.failNext = boom;
    await expect(client.callTool({ name: 'get_balance', arguments: {} })).rejects.toBe(boom);
    // The failed call is still recorded (error-rate evidence), out-of-band.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mcp.isError).toBe(true);
    expect(calls[0]!.responseBody).toBe('');
  });

  it('a throwing capture sink never disturbs the app', async () => {
    const client = new MockClient1x();
    instrumentMcpClient(client, {
      integration: 'acme-payments',
      onCapture: () => {
        throw new Error('sink exploded');
      },
      onSnapshot: () => {
        throw new Error('sink exploded');
      }
    });
    const result = await client.callTool({ name: 'get_balance', arguments: {} });
    expect(result).toBe(client.nextResult);
    await expect(client.listTools()).resolves.toBe(client.pages[0]);
  });

  it('listTools: pages pass through by identity', async () => {
    const { client } = harness1x();
    const page = await client.listTools();
    expect(page).toBe(client.pages[0]);
  });
});

describe('instrumentMcpClient — 1.x line: capture', () => {
  it('emits ONE contract_snapshot per complete paginated listTools', async () => {
    const { client, snapshots } = harness1x();
    const p1 = await client.listTools();
    expect(snapshots).toHaveLength(0); // chain not complete yet
    await client.listTools({ cursor: p1.nextCursor });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.toolCount).toBe(2);
    const parsed = JSON.parse(snapshots[0]!.snapshotJson) as { tools: { name: string }[] };
    expect(parsed.tools.map((t) => t.name)).toEqual(['get_balance', 'create_refund']);
    // identity + edge
    expect(snapshots[0]!.peerHost).toBe('mcp.acme.test');
    expect(snapshots[0]!.edgeClass).toBe('external');
    expect(snapshots[0]!.serverName).toBe('acme-payments-mcp');
    expect(snapshots[0]!.protocolVersion).toBe('2025-06-18');
  });

  it('captures the redacted call with tool slots, edge identity, session and isError', async () => {
    const { client, calls } = harness1x();
    client.nextResult = { structuredContent: { card: PAN }, isError: false };
    await client.callTool({ name: 'create_refund', arguments: { card_number: PAN } });
    const call = calls[0]!;
    expect(call.transport).toBe('mcp');
    expect(call.mcp.toolName).toBe('create_refund');
    expect(call.method).toBe('tools/call');
    expect(call.route).toBe('/create_refund');
    expect(call.peerHost).toBe('mcp.acme.test');
    expect(call.edgeClass).toBe('external');
    expect(call.mcp.serverName).toBe('acme-payments-mcp');
    expect(call.mcp.serverVersion).toBe('3.2.0');
    expect(call.mcp.protocolVersion).toBe('2025-06-18');
    expect(call.mcp.sessionId).toBe('sess_9f3c1a');
    expect(call.mcp.isError).toBe(false);
    expect(call.requestBody).toBe('{"card_number":"⟦REDACTED:PAN⟧"}');
    expect(call.responseBody).toBe('{"card":"⟦REDACTED:PAN⟧"}');
    expect(JSON.stringify(call)).not.toContain(PAN);
  });

  it('an isError result is captured with the flag (and still passed through untouched)', async () => {
    const { client, calls } = harness1x();
    const result = { content: [{ type: 'text', text: 'no such account' }], isError: true };
    client.nextResult = result;
    const got = await client.callTool({ name: 'get_balance', arguments: {} });
    expect(got).toBe(result);
    expect(calls[0]!.mcp.isError).toBe(true);
  });

  it('labels the observed JSON-RPC id as CLIENT-generated, never as a provider id', async () => {
    const { client, calls } = harness1x();
    await client.callTool({ name: 'get_balance', arguments: {} });
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[0]!.mcp.clientRequestId).toBe('1');
    expect(calls[1]!.mcp.clientRequestId).toBe('2');
    // Never presented as provider-issued:
    expect(calls[0]!.correlation.requestId).toBeUndefined();
  });

  it('refetches and re-snapshots on notifications/tools/list_changed, chaining the app handler', async () => {
    // The app installed its own fallback handler BEFORE instrumenting: chain, never clobber.
    const appHandler = vi.fn();
    const client = new MockClient1x();
    client.fallbackNotificationHandler = appHandler;
    const snapshots: McpContractSnapshot[] = [];
    instrumentMcpClient(client, { integration: 'acme-payments', onSnapshot: (s) => snapshots.push(s) });

    const note = { method: 'notifications/tools/list_changed' };
    await client.fallbackNotificationHandler!(note);
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    expect(snapshots[0]!.toolCount).toBe(2); // the refetch followed the cursor chain
    expect(appHandler).toHaveBeenCalledWith(note);
  });

  it('a failed page ends the chain: no partial snapshot, the error passes through, a later full chain still snapshots', async () => {
    const { client, snapshots } = harness1x();
    const p1 = await client.listTools();
    const boom = new Error('page 2 failed');
    client.failListTools = boom;
    await expect(client.listTools({ cursor: p1.nextCursor })).rejects.toBe(boom);
    expect(snapshots).toHaveLength(0);
    // A fresh, complete chain afterwards emits exactly one snapshot.
    const q1 = await client.listTools();
    await client.listTools({ cursor: q1.nextCursor });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.toolCount).toBe(2);
  });
});

describe('instrumentMcpClient — 2.x line (feature-detected surface)', () => {
  function harness2x() {
    const calls: McpCapturedCall[] = [];
    const snapshots: McpContractSnapshot[] = [];
    const client = new MockClient2x();
    instrumentMcpClient(client, {
      integration: 'globex-fx',
      endpoint: 'https://mcp.globex.test/mcp',
      onCapture: (c) => calls.push(c),
      onSnapshot: (s) => snapshots.push(s)
    });
    return { client, calls, snapshots };
  }

  it('callTool(name, args): pass-through by identity, capture with the 2.x identity properties', async () => {
    const { client, calls } = harness2x();
    const result = { structuredContent: { rate: 1.07 }, isError: false };
    client.nextResult = result;
    const got = await client.callTool('get_rate', { pair: 'EURUSD' });
    expect(got).toBe(result);
    expect(calls[0]!.mcp.toolName).toBe('get_rate');
    expect(calls[0]!.requestBody).toBe('{"pair":"EURUSD"}');
    expect(calls[0]!.mcp.serverName).toBe('globex-fx-mcp');
    expect(calls[0]!.mcp.serverVersion).toBe('2.0.1');
    expect(calls[0]!.mcp.protocolVersion).toBe('2026-07-28');
    expect(calls[0]!.peerHost).toBe('mcp.globex.test');
    // 2026-07-28 stateless line: no session id, honestly absent.
    expect(calls[0]!.mcp.sessionId).toBeUndefined();
    expect(calls[0]!.mcp.clientRequestId).toBeUndefined();
  });

  it('an unpaginated listTools emits its snapshot immediately, once per call', async () => {
    const { client, snapshots } = harness2x();
    await client.listTools();
    await client.listTools();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.toolCount).toBe(1);
    expect(snapshots[0]!.serverName).toBe('globex-fx-mcp');
  });
});

describe('instrumentMcpClient — two clients sharing ONE transport', () => {
  function sharedTransportHarness() {
    const callsA: McpCapturedCall[] = [];
    const callsB: McpCapturedCall[] = [];
    const clientA = new MockClient1x();
    const clientB = new MockClient1x();
    clientB.transport = clientA.transport; // ONE shared transport
    clientB.nextId = 101; // distinct id ranges make any cross-attribution visible
    instrumentMcpClient(clientA, { integration: 'acme-payments', onCapture: (c) => callsA.push(c) });
    instrumentMcpClient(clientB, { integration: 'acme-payments', onCapture: (c) => callsB.push(c) });
    return { clientA, clientB, callsA, callsB, transport: clientA.transport };
  }

  it('each client observes only its OWN tools/call ids — ids never cross clients', async () => {
    const { clientA, clientB, callsA, callsB } = sharedTransportHarness();
    await clientA.callTool({ name: 'get_balance', arguments: {} });
    await clientB.callTool({ name: 'get_balance', arguments: {} });
    await clientA.callTool({ name: 'get_balance', arguments: {} });
    expect(callsA.map((c) => c.mcp.clientRequestId)).toEqual(['1', '2']);
    expect(callsB.map((c) => c.mcp.clientRequestId)).toEqual(['101']);
  });

  it('the shared send is wrapped once: every message reaches the transport exactly once, pass-through intact', async () => {
    const { clientA, clientB, transport } = sharedTransportHarness();
    const result = { content: [{ type: 'text', text: 'ok' }], isError: false };
    clientA.nextResult = result;
    const got = await clientA.callTool({ name: 'get_balance', arguments: {} });
    await clientB.callTool({ name: 'create_refund', arguments: {} });
    expect(got).toBe(result);
    expect(transport.sent.map((m) => m.id)).toEqual([1, 101]);
  });
});

describe('instrumentMcpClient — interleaved paginated listTools chains', () => {
  it('a page whose cursor does not match the in-flight chain is discarded: no corrupted snapshot', async () => {
    const snapshots: McpContractSnapshot[] = [];
    const heads = [
      { tools: [{ name: 'alpha_1' }], nextCursor: 'a2' },
      { tools: [{ name: 'beta_1' }], nextCursor: 'b2' }
    ];
    const byCursor: Record<string, { tools: unknown[]; nextCursor?: string }> = {
      a2: { tools: [{ name: 'alpha_2' }] },
      b2: { tools: [{ name: 'beta_2' }] }
    };
    let headCalls = 0;
    const client = {
      transport: { url: 'https://mcp.acme.test/mcp', send: (): Promise<void> => Promise.resolve() },
      listTools(params?: { cursor?: string }): Promise<{ tools: unknown[]; nextCursor?: string }> {
        return Promise.resolve(params?.cursor === undefined ? heads[headCalls++]! : byCursor[params.cursor]!);
      }
    };
    instrumentMcpClient(client, { integration: 'acme-payments', onSnapshot: (s) => snapshots.push(s) });

    // Interleave two chains: head A, head B (supersedes A), page A2 (stale), page B2 (in flight).
    const headA = await client.listTools();
    const headB = await client.listTools();
    await client.listTools({ cursor: headA.nextCursor }); // chain A was superseded — its page is discarded
    expect(snapshots).toHaveLength(0); // the discarded chain produces NO snapshot, partial or otherwise
    await client.listTools({ cursor: headB.nextCursor }); // completes chain B

    expect(snapshots).toHaveLength(1); // exactly one snapshot, from the one chain that ran to completion
    const parsed = JSON.parse(snapshots[0]!.snapshotJson) as { tools: { name: string }[] };
    expect(parsed.tools.map((t) => t.name)).toEqual(['beta_1', 'beta_2']); // never a mixed alpha/beta list
  });
});

describe('instrumentMcpClient — stdio edge identity', () => {
  it('a client with no transport URL classifies local-process keyed by serverInfo.name', async () => {
    const calls: McpCapturedCall[] = [];
    const client = new MockClient1x();
    // stdio transport: no url, no session — just send().
    client.transport = { sent: [], send: client.transport.send } as unknown as MockClient1x['transport'];
    instrumentMcpClient(client, { integration: 'acme-payments', onCapture: (c) => calls.push(c) });
    await client.callTool({ name: 'get_balance', arguments: { card_number: PAN } });
    expect(calls[0]!.edgeClass).toBe('local-process');
    expect(calls[0]!.peerHost).toBe('acme-payments-mcp');
    expect(calls[0]!.mcp.serverKind).toBe('stdio');
    // local-process still captures + redacts bodies (spec §4.B).
    expect(calls[0]!.requestBody).toBe('{"card_number":"⟦REDACTED:PAN⟧"}');
  });
});

/**
 * Protocol revision **2026-07-28**: the `initialize` handshake and protocol
 * sessions are gone. A client talking to a current server therefore surfaces
 * NO `getServerVersion()`, no `serverInfo`, no `protocolVersion` and no
 * `sessionId` — identity arrives in the `_meta` of every result instead.
 *
 * This mock has none of the handshake accessors on purpose: it is what the
 * wrapper actually sees now, and every assertion below fails against the v0.5
 * implementation.
 */
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

class MockClientNoHandshake {
  // stdio: no url, no sessionId, and no protocolVersion — nothing to derive identity from.
  transport = {
    sent: [] as JsonRpcMessage[],
    send(msg: JsonRpcMessage): Promise<void> {
      this.sent.push(msg);
      return Promise.resolve();
    }
  };

  listResult: unknown = {
    tools: [{ name: 'get_balance', inputSchema: { type: 'object' } }],
    ttlMs: 60000,
    cacheScope: 'session',
    _meta: { [SERVER_INFO_KEY]: { name: 'acme-tools-mcp', version: '1.2.0' } }
  };

  nextResult: unknown = {
    content: [{ type: 'text', text: 'ok' }],
    resultType: 'complete',
    _meta: { [SERVER_INFO_KEY]: { name: 'acme-tools-mcp', version: '1.2.0' }, traceparent: TRACEPARENT }
  };

  async listTools(): Promise<unknown> {
    return this.listResult;
  }

  async callTool(params: { name: string; arguments?: unknown }): Promise<unknown> {
    await this.transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    return this.nextResult;
  }
}

function harnessNoHandshake() {
  const calls: McpCapturedCall[] = [];
  const snapshots: McpContractSnapshot[] = [];
  const client = new MockClientNoHandshake();
  instrumentMcpClient(client, {
    integration: 'acme-tools',
    onCapture: (c) => calls.push(c),
    onSnapshot: (s) => snapshots.push(s)
  });
  return { client, calls, snapshots };
}

describe('instrumentMcpClient — protocol revision 2026-07-28 (no handshake)', () => {
  it('learns server identity from a tools/call result _meta', async () => {
    const { client, calls } = harnessNoHandshake();
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[0]!.mcp.serverName).toBe('acme-tools-mcp');
    expect(calls[0]!.mcp.serverVersion).toBe('1.2.0');
  });

  /**
   * The sharpest consequence of the handshake removal. `resolveMcpEdge` keys a
   * stdio edge by `serverInfo.name`; with no source for it every local server
   * on the host collapses onto `unknown-mcp-server`, two servers share one
   * contract slot, and their alternating tool lists become phantom
   * `definition_change` findings.
   */
  it('keys the stdio edge by the _meta server name, not unknown-mcp-server', async () => {
    const { client, calls } = harnessNoHandshake();
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[0]!.peerHost).toBe('acme-tools-mcp');
    expect(calls[0]!.peerHost).not.toBe('unknown-mcp-server');
    expect(calls[0]!.edgeClass).toBe('local-process');
  });

  it('a tools/list result _meta names the server on the snapshot', async () => {
    const { client, snapshots } = harnessNoHandshake();
    await client.listTools();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.serverName).toBe('acme-tools-mcp');
    expect(snapshots[0]!.serverVersion).toBe('1.2.0');
    expect(snapshots[0]!.peerHost).toBe('acme-tools-mcp');
    const payload = JSON.parse(snapshots[0]!.snapshotJson) as { serverInfo?: { name?: string } };
    expect(payload.serverInfo?.name).toBe('acme-tools-mcp');
  });

  it('carries the catalog cache directives on the record and inside the document', async () => {
    const { client, snapshots } = harnessNoHandshake();
    await client.listTools();
    expect(snapshots[0]!.catalogTtlMs).toBe(60000);
    expect(snapshots[0]!.catalogCacheScope).toBe('session');
    const payload = JSON.parse(snapshots[0]!.snapshotJson) as { ttlMs?: number; cacheScope?: string };
    expect(payload).toMatchObject({ ttlMs: 60000, cacheScope: 'session' });
  });

  // The MCP path carried no trace id at all before this revision documented the
  // `_meta` convention, while the HTTP path filled both slots.
  it('lifts W3C trace context out of the result _meta', async () => {
    const { client, calls } = harnessNoHandshake();
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[0]!.correlation.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(calls[0]!.correlation.spanId).toBe('00f067aa0ba902b7');
  });

  it('records resultType verbatim, and leaves it absent when the server sends none', async () => {
    const { client, calls } = harnessNoHandshake();
    client.nextResult = { content: [], resultType: 'input_required' };
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[0]!.mcp.resultType).toBe('input_required');

    client.nextResult = { content: [{ type: 'text', text: 'ok' }] };
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[1]!.mcp.resultType).toBeUndefined(); // absent is not `complete`
  });

  /**
   * A Tasks handle describes the task, not the tool's output. Capturing its
   * fields as the response body is how a shape detector ends up modelling
   * `taskId`/`status`/`createdAt` as the tool's result.
   */
  it('records a Tasks handle as an envelope: task id kept, body dropped', async () => {
    const { client, calls } = harnessNoHandshake();
    client.nextResult = {
      task: { taskId: 'task_9', status: 'working', ttl: null, createdAt: 'x', lastUpdatedAt: 'x' },
      content: [{ type: 'text', text: 'accepted' }]
    };
    await client.callTool({ name: 'slow_report', arguments: {} });
    expect(calls[0]!.mcp.taskId).toBe('task_9');
    expect(calls[0]!.responseBody).toBe('');
    expect(calls[0]!.responseContentType).toBeUndefined();
  });

  it('an older server with a handshake but no _meta still resolves identity', async () => {
    const calls: McpCapturedCall[] = [];
    const client = new MockClient1x();
    instrumentMcpClient(client, { integration: 'acme-payments', onCapture: (c) => calls.push(c) });
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[0]!.mcp.serverName).toBe('acme-payments-mcp'); // the fallback still works
    expect(calls[0]!.mcp.serverVersion).toBe('3.2.0');
  });

  it('_meta identity WINS over a stale handshake value', async () => {
    const calls: McpCapturedCall[] = [];
    const client = new MockClient1x();
    client.nextResult = {
      content: [{ type: 'text', text: 'ok' }],
      _meta: { [SERVER_INFO_KEY]: { name: 'acme-payments-mcp', version: '4.0.0' } }
    };
    instrumentMcpClient(client, { integration: 'acme-payments', onCapture: (c) => calls.push(c) });
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[0]!.mcp.serverVersion).toBe('4.0.0'); // not the handshake's 3.2.0
  });

  // Sticky: a later result that says nothing must not erase what we know, or the
  // edge key would flip between the real name and `unknown-mcp-server`.
  it('keeps identity once learned, when a later result carries no _meta', async () => {
    const { client, calls } = harnessNoHandshake();
    await client.callTool({ name: 'get_balance', arguments: {} });
    client.nextResult = { content: [{ type: 'text', text: 'ok' }] };
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[1]!.mcp.serverName).toBe('acme-tools-mcp');
    expect(calls[1]!.peerHost).toBe('acme-tools-mcp');
  });

  it('sessionId is simply absent — protocol sessions are gone', async () => {
    const { client, calls } = harnessNoHandshake();
    await client.callTool({ name: 'get_balance', arguments: {} });
    expect(calls[0]!.mcp.sessionId).toBeUndefined();
  });

  it('still passes the result through by identity, _meta and all', async () => {
    const { client } = harnessNoHandshake();
    const result = client.nextResult;
    const got = await client.callTool({ name: 'get_balance', arguments: {} });
    expect(got).toBe(result);
  });
});

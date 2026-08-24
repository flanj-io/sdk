import { describe, it, expect } from 'vitest';
import { patchMcpClientConstructor, registerMcpAutoInstrumentation } from './auto-instrument';
import type { McpCapturedCall, McpContractSnapshot } from './mcp-types';

/**
 * The auto-patch path (spec §4.B): a Client CONSTRUCTOR is patched so every
 * instance self-instruments on first use — same pass-through guarantees, no
 * hard dependency on either MCP package (both are optional peers; a missing
 * package is skipped silently).
 */

class FakeClient {
  transport = { url: 'https://mcp.acme.test/mcp' };
  nextResult: unknown = { content: [{ type: 'text', text: 'ok' }], isError: false };

  getServerVersion(): { name: string; version: string } {
    return { name: 'acme-payments-mcp', version: '3.2.0' };
  }

  async listTools(): Promise<{ tools: unknown[] }> {
    return { tools: [{ name: 'get_balance' }] };
  }

  async callTool(params: { name: string; arguments?: unknown }): Promise<unknown> {
    void params;
    return this.nextResult;
  }
}

describe('patchMcpClientConstructor', () => {
  it('instances of a patched constructor self-instrument on first use, pass-through intact', async () => {
    class C extends FakeClient {}
    const calls: McpCapturedCall[] = [];
    const snapshots: McpContractSnapshot[] = [];
    expect(
      patchMcpClientConstructor(C, {
        integration: 'acme-payments',
        onCapture: (c) => calls.push(c),
        onSnapshot: (s) => snapshots.push(s)
      })
    ).toBe(true);

    const a = new C();
    const result = { structuredContent: { ok: 1 }, isError: false };
    a.nextResult = result;
    const got = await a.callTool({ name: 'get_balance', arguments: { account_id: 'x' } });
    expect(got).toBe(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mcp.toolName).toBe('get_balance');
    expect(calls[0]!.peerHost).toBe('mcp.acme.test');

    await a.listTools();
    expect(snapshots).toHaveLength(1);

    // A second instance instruments independently — one record per call, no cross-talk.
    const b = new C();
    await b.callTool({ name: 'get_balance', arguments: {} });
    expect(calls).toHaveLength(2);
  });

  it('is idempotent on the constructor and never double-captures', async () => {
    class C extends FakeClient {}
    const calls: McpCapturedCall[] = [];
    const opts = { integration: 'acme-payments', onCapture: (c: McpCapturedCall) => calls.push(c) };
    expect(patchMcpClientConstructor(C, opts)).toBe(true);
    expect(patchMcpClientConstructor(C, opts)).toBe(true);
    const a = new C();
    await a.callTool({ name: 'get_balance', arguments: {} });
    await a.callTool({ name: 'get_balance', arguments: {} });
    expect(calls).toHaveLength(2);
  });

  it('refuses non-Client-shaped values without touching them', () => {
    expect(patchMcpClientConstructor(undefined, { integration: 'x' })).toBe(false);
    expect(patchMcpClientConstructor({}, { integration: 'x' })).toBe(false);
    class NotAClient {}
    expect(patchMcpClientConstructor(NotAClient, { integration: 'x' })).toBe(false);
  });
});

describe('registerMcpAutoInstrumentation', () => {
  it('skips missing optional peers silently (neither MCP package is installed here)', async () => {
    await expect(registerMcpAutoInstrumentation({ integration: 'x' })).resolves.toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assembleMcpCall, type AssembleMcpCallInput } from './assemble-mcp-call';
import { assembleContractSnapshot, type AssembleContractSnapshotInput } from './assemble-contract-snapshot';
import { buildMcpCallAttributes, buildContractSnapshotAttributes } from './mcp-record';

/**
 * Locks the whole MCP capture path — raw args/result → floor redaction →
 * vinifera.* attributes — to the two golden fixtures (CONTRACTS §2, the
 * "v0.5 (Step B)" rows): golden-otlp-mcp-call.json and
 * golden-otlp-mcp-snapshot.json. Exact key set + exact scalar values, same
 * convention as otlp-record.spec.ts for the HTTP path.
 */

function goldenAttrs(file: string): Record<string, unknown> {
  const golden = JSON.parse(readFileSync(resolve(__dirname, `../../contracts/${file}`), 'utf8')) as {
    resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[];
  };
  const record = golden.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
  const attrs: Record<string, unknown> = {};
  for (const a of record.attributes) {
    const v = a.value;
    attrs[a.key] = v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : v.boolValue);
  }
  return attrs;
}

/** The golden call: RAW inputs — the PAN below must never survive into any attribute. */
const callInput: AssembleMcpCallInput = {
  integration: 'acme-payments',
  peerHost: 'mcp.acme.test',
  edgeClass: 'external',
  serverKind: 'streamable-http',
  toolName: 'create_refund',
  args: { amount: 1200, card_number: '4242424242424242', currency: 'usd' },
  result: {
    content: [{ type: 'text', text: 'refund created' }],
    structuredContent: { refund: { id: 're_71', amount: '1200', status: 'succeeded' } },
    isError: false
  },
  isError: false,
  serverName: 'acme-payments-mcp',
  serverVersion: '3.2.0',
  protocolVersion: '2025-06-18',
  sessionId: 'sess_9f3c1a',
  clientRequestId: '4',
  durationMs: 18
};

const snapshotInput: AssembleContractSnapshotInput = {
  integration: 'acme-payments',
  peerHost: 'mcp.acme.test',
  edgeClass: 'external',
  serverKind: 'streamable-http',
  server: { name: 'acme-payments-mcp', version: '3.2.0', protocolVersion: '2025-06-18', listChanged: true },
  tools: [
    {
      name: 'get_balance',
      description: 'Current balance for an account.',
      inputSchema: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] },
      outputSchema: {
        type: 'object',
        properties: { amount: { type: 'integer' }, currency: { type: 'string' } },
        required: ['amount', 'currency']
      }
    },
    {
      name: 'create_refund',
      description: 'Refund a charge.',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'integer' }, card_number: { type: 'string' }, currency: { type: 'string' } },
        required: ['amount', 'currency']
      },
      outputSchema: {
        type: 'object',
        properties: {
          refund: {
            type: 'object',
            properties: { id: { type: 'string' }, amount: { type: 'integer' }, status: { type: 'string' } },
            required: ['id', 'amount', 'status']
          }
        },
        required: ['refund']
      },
      annotations: { readOnlyHint: false }
    },
    {
      name: 'list_transactions',
      description: 'Recent transactions for an account.',
      inputSchema: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] }
    }
  ]
};

describe('buildMcpCallAttributes vs golden-otlp-mcp-call.json', () => {
  const golden = goldenAttrs('golden-otlp-mcp-call.json');
  const attrs = buildMcpCallAttributes(assembleMcpCall(callInput));

  it('produces exactly the golden attribute key set', () => {
    expect(new Set(Object.keys(attrs))).toEqual(new Set(Object.keys(golden)));
  });

  it('matches every golden scalar value', () => {
    for (const [key, expected] of Object.entries(golden)) {
      expect(attrs[key], `attribute ${key}`).toEqual(expected);
    }
  });

  it('never emits vinifera.http.status_code (MCP has none; is_error carries the outcome)', () => {
    expect('vinifera.http.status_code' in attrs).toBe(false);
    expect(attrs['vinifera.mcp.is_error']).toBe(false);
  });

  it('never emits the raw PAN anywhere', () => {
    expect(JSON.stringify(attrs)).not.toContain('4242424242424242');
  });

  it('carries the tool in the method/route slots and as vinifera.mcp.tool.name', () => {
    expect(attrs['vinifera.http.method']).toBe('tools/call');
    expect(attrs['vinifera.http.route']).toBe('/create_refund');
    expect(attrs['vinifera.mcp.tool.name']).toBe('create_refund');
  });

  it('labels the JSON-RPC id as client-generated, never as the provider request id', () => {
    expect(attrs['vinifera.corr.client_request_id']).toBe('4');
    expect('vinifera.corr.request_id' in attrs).toBe(false);
  });
});

describe('buildContractSnapshotAttributes vs golden-otlp-mcp-snapshot.json', () => {
  const golden = goldenAttrs('golden-otlp-mcp-snapshot.json');
  const snap = assembleContractSnapshot(snapshotInput);
  const attrs = buildContractSnapshotAttributes(snap);

  it('produces exactly the golden attribute key set', () => {
    expect(new Set(Object.keys(attrs))).toEqual(new Set(Object.keys(golden)));
  });

  it('matches every golden scalar value', () => {
    for (const [key, expected] of Object.entries(golden)) {
      expect(attrs[key], `attribute ${key}`).toEqual(expected);
    }
  });

  it('carries a ToolDef-shaped snapshot the Step C loader can decode', () => {
    const parsed = JSON.parse(snap.snapshotJson) as {
      tools: Record<string, unknown>[];
      serverInfo: { name: string; version: string };
      protocolVersion: string;
      capabilities: { tools: { listChanged: boolean } };
    };
    expect(parsed.tools.map((t) => t.name)).toEqual(['get_balance', 'create_refund', 'list_transactions']);
    for (const t of parsed.tools) {
      // ToolDef wire keys only (collector contract.ToolDef).
      for (const k of Object.keys(t)) {
        expect(['name', 'description', 'inputSchema', 'outputSchema', 'annotations']).toContain(k);
      }
    }
    // The honest "no output contract declared" state survives verbatim.
    expect('outputSchema' in parsed.tools[2]!).toBe(false);
    expect(parsed.serverInfo).toEqual({ name: 'acme-payments-mcp', version: '3.2.0' });
    expect(parsed.protocolVersion).toBe('2025-06-18');
    expect(parsed.capabilities.tools.listChanged).toBe(true);
  });
});

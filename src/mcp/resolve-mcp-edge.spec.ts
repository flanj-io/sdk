import { describe, it, expect } from 'vitest';
import { integrationForHost, resolveMcpEdge, UNKNOWN_MCP_SERVER } from './resolve-mcp-edge';

describe('resolveMcpEdge — MCP edge identity', () => {
  it('streamable HTTP: endpoint URL host is the edge key, classified by the shared heuristic', () => {
    expect(resolveMcpEdge({ endpoint: 'https://mcp.acme.test/mcp', serverName: 'acme-payments-mcp' })).toEqual({
      peerHost: 'mcp.acme.test',
      edgeClass: 'external',
      serverKind: 'streamable-http'
    });
  });

  it('streamable HTTP: a non-default port stays in the edge key', () => {
    expect(resolveMcpEdge({ endpoint: 'http://mcp.acme.test:8443/mcp' }).peerHost).toBe('mcp.acme.test:8443');
  });

  it('streamable HTTP to an internal host classifies internal (metadata-only downstream)', () => {
    expect(resolveMcpEdge({ endpoint: 'http://mcp-gw.internal/mcp' }).edgeClass).toBe('internal');
    expect(resolveMcpEdge({ endpoint: 'http://10.0.0.5:9000/mcp' }).edgeClass).toBe('internal');
  });

  it('detects the endpoint from the transport url property (string or URL)', () => {
    expect(resolveMcpEdge({ transport: { url: 'https://mcp.acme.test/mcp' } })).toEqual({
      peerHost: 'mcp.acme.test',
      edgeClass: 'external',
      serverKind: 'streamable-http'
    });
    expect(resolveMcpEdge({ transport: { _url: new URL('https://mcp.globex.test/mcp') } }).peerHost).toBe(
      'mcp.globex.test'
    );
  });

  it('stdio: serverInfo.name is the edge key and the class is local-process', () => {
    expect(resolveMcpEdge({ serverName: 'acme-local-mcp' })).toEqual({
      peerHost: 'acme-local-mcp',
      edgeClass: 'local-process',
      serverKind: 'stdio'
    });
  });

  it('stdio without a serverInfo yet falls back to the unknown-server key', () => {
    expect(resolveMcpEdge({})).toEqual({
      peerHost: UNKNOWN_MCP_SERVER,
      edgeClass: 'local-process',
      serverKind: 'stdio'
    });
  });

  it('an explicit serverKind wins over detection', () => {
    expect(resolveMcpEdge({ serverKind: 'stdio', transport: { url: 'https://mcp.acme.test/mcp' }, serverName: 's' })).toEqual({
      peerHost: 's',
      edgeClass: 'local-process',
      serverKind: 'stdio'
    });
  });

  it('never throws on a hostile transport object', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); } });
    expect(resolveMcpEdge({ transport: hostile }).serverKind).toBe('stdio');
  });
});

/**
 * The collector's `integrationForHost`, used to give each MCP server its own
 * integration when none is configured. Literals shared with the Python suite
 * (`tests/mcp/test_integration_for_host.py`).
 */
describe('integrationForHost — the collector rule', () => {
  it.each([
    ['api.stripe.com', 'api-stripe-com'],
    ['mcp.acme.com:8443', 'mcp-acme-com-8443'],
    ['Acme_Tools MCP', 'acme-tools-mcp'],
    ['--weird..host--', 'weird-host'],
    ['café-mcp', 'caf-mcp'],
    ['天气', '']
  ])('%s → %s', (host, expected) => {
    expect(integrationForHost(host)).toBe(expected);
  });
});

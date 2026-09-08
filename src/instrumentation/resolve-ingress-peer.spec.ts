import { describe, it, expect } from 'vitest';
import { resolveIngressPeer } from './resolve-ingress-peer';
import { TrustedProxies } from './trusted-proxies';

const NONE = new TrustedProxies();
const LOOPBACK = new TrustedProxies(['127.0.0.0/8', '::1']);
const TIER = new TrustedProxies(['127.0.0.0/8', '172.16.0.0/12']);

function resolve(socketAddress: string | undefined, forwardedFor: string | string[] | undefined, trustedProxies: TrustedProxies) {
  return resolveIngressPeer({ socketAddress, forwardedFor, trustedProxies });
}

describe('resolveIngressPeer — no trusted proxies configured (the default)', () => {
  it('ignores X-Forwarded-For entirely: the socket peer is the caller', () => {
    expect(resolve('127.0.0.1', '203.0.113.7', NONE)).toBe('127.0.0.1');
    expect(resolve('203.0.113.9', '10.0.0.1', NONE)).toBe('203.0.113.9');
    expect(resolve('203.0.113.9', undefined, NONE)).toBe('203.0.113.9');
  });

  it('a spoofed PRIVATE first hop cannot turn an external caller internal', () => {
    // Exploit (a): "X-Forwarded-For: 10.0.0.1" from the public internet.
    expect(resolve('203.0.113.9', '10.0.0.1', NONE)).toBe('203.0.113.9');
  });

  it('a spoofed PUBLIC first hop cannot turn an internal caller external', () => {
    // Exploit (b): an internal service claims to be a public client.
    expect(resolve('10.4.4.4', '203.0.113.7', NONE)).toBe('10.4.4.4');
  });

  it('reports an empty caller when the socket exposed no address', () => {
    expect(resolve(undefined, '203.0.113.7', NONE)).toBe('');
  });
});

describe('resolveIngressPeer — behind a trusted proxy', () => {
  it('believes the header only when the SOCKET peer is a trusted proxy', () => {
    expect(resolve('127.0.0.1', '203.0.113.7', LOOPBACK)).toBe('203.0.113.7');
    expect(resolve('198.51.100.2', '203.0.113.7', LOOPBACK)).toBe('198.51.100.2'); // not our proxy
    expect(resolve('::ffff:127.0.0.1', '203.0.113.7', LOOPBACK)).toBe('203.0.113.7'); // dual-stack spelling
  });

  it('takes the hop our proxy APPENDED (rightmost untrusted), never the leftmost', () => {
    // The client sent "X-Forwarded-For: 10.0.0.1"; the proxy appended the client's real address.
    expect(resolve('127.0.0.1', '10.0.0.1, 203.0.113.7', LOOPBACK)).toBe('203.0.113.7');
    // An INTERNAL caller behind the proxy claims a public identity — its real address wins.
    expect(resolve('127.0.0.1', '203.0.113.7, 192.168.1.20', LOOPBACK)).toBe('192.168.1.20');
  });

  it('walks past every trusted hop of a multi-tier proxy chain', () => {
    // edge LB (172.16.5.5) -> loopback sidecar -> app; the client's own header first.
    expect(resolve('127.0.0.1', '198.51.100.4, 203.0.113.7, 172.16.5.5', TIER)).toBe('203.0.113.7');
    expect(resolve('127.0.0.1', '203.0.113.7, 172.16.5.5, 172.16.0.9', TIER)).toBe('203.0.113.7');
  });

  it('a chain made only of trusted hops originated inside the proxy tier: its leftmost address', () => {
    expect(resolve('127.0.0.1', '172.16.5.5', TIER)).toBe('172.16.5.5');
    expect(resolve('127.0.0.1', '172.16.0.9, 172.16.5.5', TIER)).toBe('172.16.0.9');
  });

  it('falls back to the socket peer when the trusted proxy sent no usable header', () => {
    expect(resolve('127.0.0.1', undefined, LOOPBACK)).toBe('127.0.0.1');
    expect(resolve('127.0.0.1', '', LOOPBACK)).toBe('127.0.0.1');
    expect(resolve('127.0.0.1', ' , ,', LOOPBACK)).toBe('127.0.0.1');
  });

  it('keeps a hostname hop verbatim (a proxy that forwards a name, e.g. the e2e consumers)', () => {
    expect(resolve('127.0.0.1', 'api.consumer-a.test', LOOPBACK)).toBe('api.consumer-a.test');
    expect(resolve('127.0.0.1', '10.0.0.1, api.consumer-a.test', LOOPBACK)).toBe('api.consumer-a.test');
  });

  it('handles the array shape and whitespace around hops', () => {
    expect(resolve('127.0.0.1', ['10.0.0.1', ' 203.0.113.7 '], LOOPBACK)).toBe('203.0.113.7');
    expect(resolve('127.0.0.1', ['10.0.0.1, 203.0.113.7', '127.0.0.2'], LOOPBACK)).toBe('203.0.113.7');
  });

  it('a hop carrying a port is still recognised as a trusted proxy', () => {
    expect(resolve('127.0.0.1', '203.0.113.7, 172.16.5.5:8080', TIER)).toBe('203.0.113.7');
  });
});

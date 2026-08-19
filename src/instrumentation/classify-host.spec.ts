import { describe, it, expect } from 'vitest';
import { classifyHost, type EdgeClass } from './classify-host';

/**
 * The classification heuristic is a CROSS-COMPONENT contract — the collector
 * classifies identically. This table is the SDK's copy of that shared truth.
 */
const table: ReadonlyArray<[string, EdgeClass]> = [
  // RFC1918
  ['10.0.0.5', 'internal'],
  ['10.255.255.255', 'internal'],
  ['172.16.0.1', 'internal'],
  ['172.31.255.254', 'internal'],
  ['172.20.10.1', 'internal'],
  ['192.168.1.10', 'internal'],
  ['192.168.0.1:8443', 'internal'],
  // NOT RFC1918 (adjacent public ranges)
  ['172.15.0.1', 'external'],
  ['172.32.0.1', 'external'],
  ['11.0.0.1', 'external'],
  ['192.169.0.1', 'external'],
  // loopback
  ['127.0.0.1', 'internal'],
  ['127.0.0.1:3000', 'internal'],
  ['127.99.1.2', 'internal'],
  ['::1', 'internal'],
  ['[::1]:8080', 'internal'],
  ['localhost', 'internal'],
  ['localhost:5432', 'internal'],
  ['::ffff:127.0.0.1', 'internal'], // IPv4-mapped loopback (dual-stack socket)
  // link-local
  ['169.254.10.20', 'internal'],
  ['fe80::1', 'internal'], // IPv6 link-local fe80::/10
  ['[fe80::abcd]:443', 'internal'],
  ['::', 'internal'], // unspecified
  // ULA IPv6
  ['fc00::1', 'internal'],
  ['fd12:3456:789a::1', 'internal'],
  ['[fd00::1]:9000', 'internal'],
  // cluster / internal name suffixes
  ['payments.default.svc.cluster.local', 'internal'],
  ['db.internal', 'internal'],
  ['printer.local', 'internal'],
  ['api.staging.svc.cluster.local:8080', 'internal'],
  // single-label hostnames
  ['postgres', 'internal'],
  ['redis', 'internal'],
  ['payments', 'internal'],
  ['payments:5000', 'internal'],
  // public IPs
  ['203.0.113.7', 'external'],
  ['8.8.8.8', 'external'],
  ['[2001:db8::1]:443', 'external'],
  ['2001:db8::1', 'external'],
  // public DNS names
  ['api.acme.test', 'external'],
  ['api.stripe.com', 'external'],
  ['api.acme.test:443', 'external'],
  ['sub.domain.example.com', 'external']
];

describe('classifyHost', () => {
  it.each(table)('classifies %s as %s', (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });

  it('treats empty/whitespace host as internal (fail closed — no surfacing)', () => {
    expect(classifyHost('')).toBe('internal');
    expect(classifyHost('   ')).toBe('internal');
  });

  it('is case-insensitive for names and IPv6', () => {
    expect(classifyHost('API.ACME.TEST')).toBe('external');
    expect(classifyHost('FD00::1')).toBe('internal');
    expect(classifyHost('DB.INTERNAL')).toBe('internal');
  });
});

import { describe, it, expect } from 'vitest';
import { TrustedProxies } from './trusted-proxies';

describe('TrustedProxies — the peers whose X-Forwarded-For may be believed', () => {
  it('the default (empty) set trusts nobody, not even loopback', () => {
    for (const set of [new TrustedProxies(), new TrustedProxies([]), new TrustedProxies(['', '  '])]) {
      expect(set.size).toBe(0);
      expect(set.isTrusted('127.0.0.1')).toBe(false);
      expect(set.isTrusted('::1')).toBe(false);
      expect(set.isTrusted('10.0.0.1')).toBe(false);
    }
  });

  it('matches bare IPv4 / IPv6 addresses exactly', () => {
    const set = new TrustedProxies(['10.0.0.5', '::1']);
    expect(set.size).toBe(2);
    expect(set.isTrusted('10.0.0.5')).toBe(true);
    expect(set.isTrusted('10.0.0.6')).toBe(false);
    expect(set.isTrusted('::1')).toBe(true);
    expect(set.isTrusted('::2')).toBe(false);
  });

  it('matches CIDR blocks, IPv4 and IPv6', () => {
    const set = new TrustedProxies(['10.0.0.0/8', '172.16.0.0/12', 'fd00::/8']);
    expect(set.isTrusted('10.255.1.2')).toBe(true);
    expect(set.isTrusted('11.0.0.1')).toBe(false);
    expect(set.isTrusted('172.31.9.9')).toBe(true);
    expect(set.isTrusted('172.32.0.1')).toBe(false);
    expect(set.isTrusted('fd12:3456::1')).toBe(true);
    expect(set.isTrusted('fe80::1')).toBe(false);
  });

  it('normalizes the shapes a socket / a forwarded hop actually carries', () => {
    const set = new TrustedProxies(['10.0.0.0/8', 'fe80::/10', '::1']);
    expect(set.isTrusted('::ffff:10.1.2.3')).toBe(true); // IPv4-mapped (dual-stack sockets)
    expect(set.isTrusted('10.1.2.3:4318')).toBe(true); // hop with a port
    expect(set.isTrusted('[::1]:4318')).toBe(true); // bracketed IPv6 with a port
    expect(set.isTrusted('fe80::1%eth0')).toBe(true); // zone id
    expect(set.isTrusted(' 10.9.9.9 ')).toBe(true); // whitespace
    expect(set.isTrusted('::FFFF:10.1.2.3')).toBe(true); // case
  });

  it('never trusts a non-IP hop: hostnames, "unknown", garbage, empty', () => {
    const set = new TrustedProxies(['0.0.0.0/0', '::/0']);
    expect(set.isTrusted('1.2.3.4')).toBe(true); // sanity: the widest possible set
    expect(set.isTrusted('api.consumer-a.test')).toBe(false);
    expect(set.isTrusted('unknown')).toBe(false);
    expect(set.isTrusted('_hidden')).toBe(false);
    expect(set.isTrusted('')).toBe(false);
    expect(set.isTrusted(undefined)).toBe(false);
  });

  it('accepts entries with surrounding whitespace and a mapped-IPv4 spelling', () => {
    const set = new TrustedProxies([' 10.0.0.0/8 ', '::ffff:192.168.1.1']);
    expect(set.isTrusted('10.0.0.1')).toBe(true);
    expect(set.isTrusted('192.168.1.1')).toBe(true);
  });

  it('THROWS on an entry that is neither an IP nor a CIDR — a typo must fail the boot, not silently un-trust', () => {
    expect(() => new TrustedProxies(['proxy.internal'])).toThrow(/not an IP address or CIDR/);
    expect(() => new TrustedProxies(['10.0.0.0/33'])).toThrow(/invalid prefix length \(0-32\)/);
    expect(() => new TrustedProxies(['fd00::/129'])).toThrow(/invalid prefix length \(0-128\)/);
    expect(() => new TrustedProxies(['10.0.0.0/'])).toThrow(/invalid prefix length/);
    expect(() => new TrustedProxies(['10.0.0.0/eight'])).toThrow(/invalid prefix length/);
    expect(() => new TrustedProxies(['*'])).toThrow(/not an IP address or CIDR/);
  });
});

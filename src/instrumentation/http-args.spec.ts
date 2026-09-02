import { describe, it, expect } from 'vitest';
import { parseRequestArgs } from './http-args';

/**
 * `info.host` becomes `flanj.peer.host` — the EDGE KEY (CONTRACTS §2
 * `host[:port]`) — and also the authority in `flanj.http.url.full`. Contract
 * binding on the collector is an exact-string lookup on that key, so one origin
 * dialled two ways MUST produce one string: a contract bound to the bare host
 * would otherwise never validate the `:443` spelling, its drifted responses
 * would produce no finding, and the Edges row would still show the contract's
 * name (naming is domain-level, binding is host-level).
 */
describe('parseRequestArgs — the peer host is one edge key per origin', () => {
  it('takes the host from a URL string, default port already absent', () => {
    expect(parseRequestArgs(['https://api.acme.test/v1/charges'], 'https:')).toMatchObject({
      method: 'GET',
      protocol: 'https:',
      host: 'api.acme.test',
      path: '/v1/charges'
    });
  });

  it('drops an EXPLICIT default port from an options dial, so it keys as the URL dial', () => {
    const fromUrl = parseRequestArgs(['https://api.acme.test/v1/charges'], 'https:');
    const fromOptions = parseRequestArgs(
      [{ hostname: 'api.acme.test', port: 443, path: '/v1/charges', protocol: 'https:' }],
      'https:'
    );
    // The defect this test exists for: these two dialled the same origin.
    expect(fromOptions.host).toBe('api.acme.test');
    expect(fromOptions.host).toBe(fromUrl.host);
  });

  it('drops :80 on http and :443 on https, and only the scheme default', () => {
    expect(parseRequestArgs([{ hostname: 'api.acme.test', port: 80 }], 'http:').host).toBe('api.acme.test');
    expect(parseRequestArgs([{ hostname: 'api.acme.test', port: 443 }], 'https:').host).toBe('api.acme.test');
    // :443 is NOT http's default — a listener on it is a real, different edge.
    expect(parseRequestArgs([{ hostname: 'api.acme.test', port: 443 }], 'http:').host).toBe('api.acme.test:443');
    expect(parseRequestArgs([{ hostname: 'api.acme.test', port: 80 }], 'https:').host).toBe('api.acme.test:80');
  });

  it('KEEPS a non-default port — it is a different listener, not a spelling', () => {
    expect(parseRequestArgs([{ hostname: 'api.acme.test', port: 28080 }], 'https:').host).toBe(
      'api.acme.test:28080'
    );
    expect(parseRequestArgs([{ hostname: 'api.acme.test', port: '8080' }], 'http:').host).toBe(
      'api.acme.test:8080'
    );
    expect(parseRequestArgs(['https://api.acme.test:8443/v1'], 'https:').host).toBe('api.acme.test:8443');
  });

  it('normalises a port carried on options.host, the shape a shared helper produces', () => {
    expect(parseRequestArgs([{ host: 'api.acme.test:443', path: '/v1' }], 'https:').host).toBe('api.acme.test');
    expect(parseRequestArgs([{ host: 'api.acme.test:8080', path: '/v1' }], 'https:').host).toBe(
      'api.acme.test:8080'
    );
  });

  it('leaves IPv6 literals intact, bracketed default port aside', () => {
    expect(parseRequestArgs([{ hostname: '[::1]', port: 443 }], 'https:').host).toBe('[::1]');
    expect(parseRequestArgs([{ hostname: '[::1]', port: 8443 }], 'https:').host).toBe('[::1]:8443');
    // A bare, unbracketed IPv6 literal is all colons and carries no port.
    expect(parseRequestArgs([{ hostname: 'fd00::1' }], 'https:').host).toBe('fd00::1');
  });

  it('is idempotent: an already-normalised host survives untouched', () => {
    for (const [dial, protocol] of [
      ['api.acme.test', 'https:'],
      ['api.acme.test:8080', 'https:'],
      ['[::1]', 'http:']
    ] as const) {
      expect(parseRequestArgs([{ hostname: dial }], protocol).host).toBe(dial);
    }
  });

  it('uses the URL scheme over the module default when they disagree', () => {
    // https.request('http://…') — the port that counts is the URL's scheme's.
    expect(parseRequestArgs([{ hostname: 'api.acme.test', port: 80, protocol: 'http:' }], 'https:')).toMatchObject(
      { protocol: 'http:', host: 'api.acme.test' }
    );
  });

  it('still carries method and path through both shapes', () => {
    expect(parseRequestArgs([{ hostname: 'api.acme.test', method: 'post', path: '/v1/charges?a=1' }], 'https:')).toMatchObject(
      { method: 'POST', path: '/v1/charges?a=1' }
    );
    expect(parseRequestArgs(['https://api.acme.test/v1?a=1'], 'https:').path).toBe('/v1?a=1');
    // request(url, options) — the options half merges over the URL half.
    expect(parseRequestArgs(['https://api.acme.test/v1', { method: 'PUT' }], 'https:')).toMatchObject({
      method: 'PUT',
      host: 'api.acme.test'
    });
  });

  it('falls back to localhost for an options dial naming no host', () => {
    expect(parseRequestArgs([{ path: '/health' }], 'http:').host).toBe('localhost');
  });

  it('treats an unparseable URL string as no URL at all, never throwing', () => {
    expect(parseRequestArgs(['not a url'], 'https:').host).toBe('localhost');
  });
});

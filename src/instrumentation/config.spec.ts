import { describe, it, expect } from 'vitest';
import { DEFAULT_CAPTURE_CONTENT_TYPES, isCaptureableContentType } from './config';

/**
 * The content-type gate decides whether a body is kept at all. Before RFC 6839
 * suffix matching it compared the raw header against `application/json` by
 * prefix, so every `+json` type — `application/problem+json` first among them,
 * the standard error payload — silently captured NO body in either direction,
 * and the collector had nothing to validate on exactly the responses most worth
 * checking against a contract.
 */
describe('isCaptureableContentType — RFC 6839 `+json` types are JSON', () => {
  it.each([
    'application/problem+json',
    'application/vnd.api+json',
    'application/hal+json',
    'application/ld+json',
    'application/merge-patch+json',
    'application/json-patch+json',
    'application/vnd.acme.v2+json'
  ])('captures %s under the default list', (contentType) => {
    expect(isCaptureableContentType(contentType, DEFAULT_CAPTURE_CONTENT_TYPES)).toBe(true);
  });

  it.each(['application/json', 'application/x-www-form-urlencoded', 'text/plain', 'text/html', 'text/csv'])(
    'still captures the plain default %s',
    (contentType) => {
      expect(isCaptureableContentType(contentType, DEFAULT_CAPTURE_CONTENT_TYPES)).toBe(true);
    }
  );

  it.each([
    'application/problem+json; charset=utf-8',
    'application/json;charset=UTF-8',
    'Application/Problem+JSON; Charset=UTF-8',
    '  application/vnd.api+json ; ext="https://jsonapi.org/ext/atomic"',
    'text/plain; charset=iso-8859-1'
  ])('ignores parameters, case and whitespace: %s', (contentType) => {
    expect(isCaptureableContentType(contentType, DEFAULT_CAPTURE_CONTENT_TYPES)).toBe(true);
  });

  it.each([
    'application/octet-stream',
    'multipart/form-data; boundary=----x',
    'image/png',
    'image/jpeg',
    'application/pdf',
    'application/zip',
    'application/xml',
    // A structured suffix the default list does not know stays out until the
    // list grows an XML base type.
    'image/svg+xml',
    'application/soap+xml',
    // `json` must be the whole structured suffix, not a prefix of one.
    'application/vnd.acme+jsonx',
    'application/x-ndjson'
  ])('still captures no body for %s', (contentType) => {
    expect(isCaptureableContentType(contentType, DEFAULT_CAPTURE_CONTENT_TYPES)).toBe(false);
  });

  it.each([undefined, '', '   ', '; charset=utf-8', ';'])('captures nothing without a media type (%j)', (contentType) => {
    expect(isCaptureableContentType(contentType, DEFAULT_CAPTURE_CONTENT_TYPES)).toBe(false);
  });
});

describe('isCaptureableContentType — the operator override keeps its prefix semantics', () => {
  it('a list without application/json drops the +json types with it', () => {
    const textOnly = ['text/'];
    expect(isCaptureableContentType('text/csv', textOnly)).toBe(true);
    expect(isCaptureableContentType('application/json', textOnly)).toBe(false);
    expect(isCaptureableContentType('application/problem+json', textOnly)).toBe(false);
  });

  it('a single +json type on its own captures only itself, not the base type', () => {
    const problemOnly = ['application/problem+json'];
    expect(isCaptureableContentType('application/problem+json; charset=utf-8', problemOnly)).toBe(true);
    expect(isCaptureableContentType('application/json', problemOnly)).toBe(false);
    expect(isCaptureableContentType('application/hal+json', problemOnly)).toBe(false);
  });

  it('a vendor prefix matches its versioned +json media types, as it did before', () => {
    const vendor = ['application/vnd.acme'];
    expect(isCaptureableContentType('application/vnd.acme.v2+json', vendor)).toBe(true);
    expect(isCaptureableContentType('application/vnd.acme+xml', vendor)).toBe(true);
    expect(isCaptureableContentType('application/vnd.other+json', vendor)).toBe(false);
  });

  it('matches entries case-insensitively and ignores blank ones', () => {
    expect(isCaptureableContentType('application/problem+json', ['Application/JSON'])).toBe(true);
    expect(isCaptureableContentType('application/json', ['', '  '])).toBe(false);
  });

  it('an empty list captures nothing', () => {
    expect(isCaptureableContentType('application/json', [])).toBe(false);
  });
});

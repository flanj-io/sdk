import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OTLP_LOGS_ENDPOINT,
  normalizeOtlpLogsEndpoint,
  resolveOtlpLogsEndpoint
} from './otlp-endpoint';

/**
 * The 404-in-total-silence bug: OTel appends `v1/logs` only on the
 * OTEL_EXPORTER_OTLP_ENDPOINT env path, never for an explicit `url`, so a base
 * URL POSTs to `/` and the collector answers 404. Normalizing is the fix.
 */
describe('normalizeOtlpLogsEndpoint', () => {
  it('appends /v1/logs to a base URL', () => {
    expect(normalizeOtlpLogsEndpoint('http://localhost:4318')).toBe('http://localhost:4318/v1/logs');
  });

  it('appends /v1/logs to a base URL with a trailing slash', () => {
    expect(normalizeOtlpLogsEndpoint('http://localhost:4318/')).toBe('http://localhost:4318/v1/logs');
  });

  it('leaves the full logs path unchanged', () => {
    expect(normalizeOtlpLogsEndpoint('http://localhost:4318/v1/logs')).toBe(
      'http://localhost:4318/v1/logs'
    );
  });

  it('leaves a custom path unchanged', () => {
    expect(normalizeOtlpLogsEndpoint('https://otlp.example.com/ingest/v1/logs')).toBe(
      'https://otlp.example.com/ingest/v1/logs'
    );
  });

  it('leaves a non-logs custom path alone rather than guessing', () => {
    expect(normalizeOtlpLogsEndpoint('https://otlp.example.com/collect')).toBe(
      'https://otlp.example.com/collect'
    );
  });

  it('keeps host, port, scheme and query when appending', () => {
    expect(normalizeOtlpLogsEndpoint('https://collector.internal:8443?tenant=acme')).toBe(
      'https://collector.internal:8443/v1/logs?tenant=acme'
    );
  });

  it('returns an unparseable value verbatim (the exporter owns that error)', () => {
    expect(normalizeOtlpLogsEndpoint('not a url')).toBe('not a url');
  });
});

describe('resolveOtlpLogsEndpoint', () => {
  it('defaults to the collector on :4318', () => {
    expect(resolveOtlpLogsEndpoint(undefined, {})).toBe(DEFAULT_OTLP_LOGS_ENDPOINT);
  });

  it('prefers the explicit option over every environment variable', () => {
    const env = {
      FLANJ_OTLP_ENDPOINT: 'http://flanj:4318/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs:4318/v1/logs',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318'
    };
    expect(resolveOtlpLogsEndpoint('http://explicit:4318/v1/logs', env)).toBe(
      'http://explicit:4318/v1/logs'
    );
  });

  it('prefers FLANJ_OTLP_ENDPOINT over the OTEL_* fallbacks', () => {
    const env = {
      FLANJ_OTLP_ENDPOINT: 'http://flanj:4318/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs:4318/v1/logs',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318'
    };
    expect(resolveOtlpLogsEndpoint(undefined, env)).toBe('http://flanj:4318/v1/logs');
  });

  it('falls back to OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', () => {
    const env = {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs:4318/v1/logs',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318'
    };
    expect(resolveOtlpLogsEndpoint(undefined, env)).toBe('http://logs:4318/v1/logs');
  });

  it('falls back to OTEL_EXPORTER_OTLP_ENDPOINT last', () => {
    expect(resolveOtlpLogsEndpoint(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })).toBe(
      'http://otel:4318/v1/logs'
    );
  });

  it('normalizes a base URL taken from the environment', () => {
    expect(resolveOtlpLogsEndpoint(undefined, { FLANJ_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(
      'http://collector:4318/v1/logs'
    );
  });

  it('treats a blank environment value as unset', () => {
    const env = { FLANJ_OTLP_ENDPOINT: '   ', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' };
    expect(resolveOtlpLogsEndpoint(undefined, env)).toBe('http://otel:4318/v1/logs');
  });
});

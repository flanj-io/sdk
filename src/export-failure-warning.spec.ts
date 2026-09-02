import { describe, it, expect } from 'vitest';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { exportFailureMessage, withExportFailureWarning } from './export-failure-warning';

const SUCCESS = 0;
const FAILED = 1;

/** An exporter that reports whatever result the test hands it. */
function stubExporter(result: { code: number; error?: Error }): LogRecordExporter & {
  calls: number;
} {
  const exporter = {
    calls: 0,
    export(_logs: ReadableLogRecord[], resultCallback: (r: any) => void): void {
      exporter.calls += 1;
      resultCallback(result);
    },
    shutdown: async (): Promise<void> => undefined,
    forceFlush: async (): Promise<void> => undefined
  };
  return exporter as LogRecordExporter & { calls: number };
}

function otlpError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

describe('exportFailureMessage', () => {
  it('carries the HTTP status code', () => {
    expect(exportFailureMessage('http://localhost:4318/', otlpError('Not Found', 404))).toContain(
      'HTTP 404'
    );
  });

  it('points a 404 at the missing /v1/logs path', () => {
    const message = exportFailureMessage('http://localhost:4318/', otlpError('Not Found', 404));
    expect(message).toContain('http://localhost:4318/v1/logs');
  });

  it('names the endpoint it failed to reach', () => {
    const message = exportFailureMessage('http://collector:4318/v1/logs', otlpError('Bad', 500));
    expect(message).toContain('http://collector:4318/v1/logs');
  });

  it('falls back to the error message when there is no status code', () => {
    const message = exportFailureMessage(
      'http://localhost:4318/v1/logs',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    );
    expect(message).toContain('connect ECONNREFUSED');
  });

  it('is a single line', () => {
    expect(exportFailureMessage('http://localhost:4318/', otlpError('Not Found', 404))).not.toContain(
      '\n'
    );
  });
});

describe('withExportFailureWarning', () => {
  it('warns once on the first failure, never again', () => {
    const warnings: string[] = [];
    const wrapped = withExportFailureWarning(
      stubExporter({ code: FAILED, error: otlpError('Not Found', 404) }),
      'http://localhost:4318/',
      (m) => warnings.push(m)
    );

    for (let i = 0; i < 3; i += 1) wrapped.export([], () => undefined);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('HTTP 404');
  });

  it('stays silent while exports succeed', () => {
    const warnings: string[] = [];
    const wrapped = withExportFailureWarning(stubExporter({ code: SUCCESS }), 'http://x/v1/logs', (m) =>
      warnings.push(m)
    );

    wrapped.export([], () => undefined);

    expect(warnings).toHaveLength(0);
  });

  it('passes the result through to the caller unchanged', () => {
    const result = { code: FAILED, error: otlpError('Not Found', 404) };
    const wrapped = withExportFailureWarning(stubExporter(result), 'http://x/', () => undefined);

    let seen: unknown;
    wrapped.export([], (r) => {
      seen = r;
    });

    expect(seen).toBe(result);
  });

  it('delegates shutdown and forceFlush', async () => {
    const inner = stubExporter({ code: SUCCESS });
    const wrapped = withExportFailureWarning(inner, 'http://x/', () => undefined);

    await expect(wrapped.shutdown()).resolves.toBeUndefined();
    await expect(wrapped.forceFlush()).resolves.toBeUndefined();
  });
});

import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';

/** `ExportResult` without taking a direct dependency on `@opentelemetry/core`. */
type ExportResultLike = Parameters<Parameters<LogRecordExporter['export']>[1]>[0];

/** `ExportResultCode.SUCCESS === 0` in `@opentelemetry/core`; inlined to avoid the dep. */
const SUCCESS = 0;

/** Emit the warning; overridable so tests can capture it. */
export type WarnFn = (message: string) => void;

/**
 * Wrap a logs exporter so the **first** export failure prints one line to
 * stderr, carrying the HTTP status code when the transport reports one.
 *
 * Without this the failure mode is total silence: the OTel SDK routes export
 * errors to `diag`, no diag logger is registered by default, and a collector
 * answering 404 (see `otlp-endpoint.ts`) therefore produces zero rows, zero
 * stderr and exit 0. Wrapping the exporter — rather than registering a global
 * diag logger — keeps us out of the host application's own diag configuration.
 *
 * Only the first failure is reported: a misconfigured endpoint fails on every
 * batch, and a per-batch log line would be its own kind of damage.
 */
export function withExportFailureWarning(
  exporter: LogRecordExporter,
  endpoint: string,
  warn: WarnFn = defaultWarn
): LogRecordExporter {
  let warned = false;

  return {
    export(logs: ReadableLogRecord[], resultCallback: (result: ExportResultLike) => void): void {
      exporter.export(logs, (result) => {
        if (!warned && result.code !== SUCCESS) {
          warned = true;
          warn(exportFailureMessage(endpoint, result.error));
        }
        resultCallback(result);
      });
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush()
  };
}

/** One line: what failed, where, and the status code if we have one. */
export function exportFailureMessage(endpoint: string, error?: Error): string {
  const status = httpStatusOf(error);
  const detail = status !== undefined ? `HTTP ${status}` : (error?.message ?? 'unknown error');
  const hint =
    status === 404
      ? ` — the endpoint must include the OTLP logs path, e.g. ${endpoint.replace(/\/*$/, '')}/v1/logs`
      : '';
  return `[flanj] OTLP log export to ${endpoint} failed: ${detail}${hint}. Captured calls are being dropped; this warning is not repeated.`;
}

/**
 * `OTLPExporterError.code` carries the response status for a non-retryable
 * HTTP failure. It is typed loosely upstream, so read it defensively.
 */
function httpStatusOf(error?: Error): number | undefined {
  const code: unknown = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string') {
    const n = Number.parseInt(code, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

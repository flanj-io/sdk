import { LoggerProvider, BatchLogRecordProcessor, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { HttpBodyCaptureInstrumentation } from './instrumentation/http-body-capture';
import { emitCall } from './instrumentation/otlp-record';
import { SDK_NAME, SDK_VERSION } from './version';

export interface StartOptions {
  /** Integration id emitted as `vinifera.integration`. Env: VINIFERA_INTEGRATION_ID. */
  integration?: string;
  /** service.name resource attribute. Env: OTEL_SERVICE_NAME. */
  serviceName?: string;
  /** OTLP/HTTP logs endpoint. Env: VINIFERA_OTLP_ENDPOINT. Default http://localhost:4318/v1/logs. */
  otlpEndpoint?: string;
  /** Body capture cap in bytes. Env: VINIFERA_BODY_CAP_BYTES. Default 16384. */
  bodyCapBytes?: number;
  /** Use a SimpleLogRecordProcessor (flush per record) instead of batch — handy for tests. */
  simpleProcessor?: boolean;
  /** Provide a custom processor (e.g. an in-memory exporter) — overrides the OTLP exporter. */
  processor?: LogRecordProcessor;
}

export interface ViniferaHandle {
  loggerProvider: LoggerProvider;
  instrumentation: HttpBodyCaptureInstrumentation;
  shutdown: () => Promise<void>;
}

/**
 * Start the Vinifera SDK: register the http/https body-capture instrumentation
 * and wire each captured (already-redacted) call to a logs OTLP/HTTP exporter
 * on :4318. Returns a handle for shutdown.
 */
export function start(options: StartOptions = {}): ViniferaHandle {
  const integration = options.integration ?? process.env.VINIFERA_INTEGRATION_ID ?? 'unknown-integration';
  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'vinifera-consumer';
  const endpoint =
    options.otlpEndpoint ?? process.env.VINIFERA_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/logs';
  const bodyCapBytes = options.bodyCapBytes ?? envInt('VINIFERA_BODY_CAP_BYTES');

  const processor: LogRecordProcessor =
    options.processor ??
    (options.simpleProcessor
      ? new SimpleLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) })
      : new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) }));

  const loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'telemetry.sdk.name': SDK_NAME
    }),
    processors: [processor]
  });

  const logger = loggerProvider.getLogger(SDK_NAME, SDK_VERSION);

  const instrumentation = new HttpBodyCaptureInstrumentation({
    integration,
    bodyCapBytes,
    onCapture: (call) => emitCall(logger, call)
  });

  return {
    loggerProvider,
    instrumentation,
    shutdown: async () => {
      instrumentation.disable();
      await loggerProvider.shutdown();
    }
  };
}

function envInt(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export { HttpBodyCaptureInstrumentation } from './instrumentation/http-body-capture';
export { buildLogAttributes, emitCall } from './instrumentation/otlp-record';
export type { CapturedCall } from './instrumentation/captured-call';
export type { HttpBodyCaptureConfig } from './instrumentation/config';

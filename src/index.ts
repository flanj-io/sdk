import { LoggerProvider, BatchLogRecordProcessor, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { HttpBodyCaptureInstrumentation } from './instrumentation/http-body-capture';
import { HttpServerCaptureInstrumentation } from './instrumentation/http-server-capture';
import { emitCall } from './instrumentation/otlp-record';
import { SDK_NAME, SDK_VERSION } from './version';

export interface StartOptions {
  /** Integration id emitted as `flanj.integration`. Env: FLANJ_INTEGRATION_ID. */
  integration?: string;
  /** service.name resource attribute. Env: OTEL_SERVICE_NAME. */
  serviceName?: string;
  /** OTLP/HTTP logs endpoint. Env: FLANJ_OTLP_ENDPOINT. Default http://localhost:4318/v1/logs. */
  otlpEndpoint?: string;
  /** Body capture cap in bytes. Env: FLANJ_BODY_CAP_BYTES. Default 16384. */
  bodyCapBytes?: number;
  /** Use a SimpleLogRecordProcessor (flush per record) instead of batch — handy for tests. */
  simpleProcessor?: boolean;
  /** Provide a custom processor (e.g. an in-memory exporter) — overrides the OTLP exporter. */
  processor?: LogRecordProcessor;
  /**
   * Extra full-URL ignore matchers (never captured). The SDK always ignores its
   * own OTLP endpoint host; add more here (e.g. health-check or metrics hosts).
   */
  ignoreUrls?: readonly (string | RegExp)[];
}

export interface FlanjHandle {
  loggerProvider: LoggerProvider;
  /** Egress (client-path) body-capture instrumentation. */
  instrumentation: HttpBodyCaptureInstrumentation;
  /** Ingress (server-path) body-capture instrumentation. */
  serverInstrumentation: HttpServerCaptureInstrumentation;
  shutdown: () => Promise<void>;
}

/**
 * Start the Flanj SDK: register the http/https body-capture instrumentation
 * and wire each captured (already-redacted) call to a logs OTLP/HTTP exporter
 * on :4318. Returns a handle for shutdown.
 */
export function start(options: StartOptions = {}): FlanjHandle {
  const integration = options.integration ?? process.env.FLANJ_INTEGRATION_ID ?? 'unknown-integration';
  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'flanj-consumer';
  const endpoint =
    options.otlpEndpoint ?? process.env.FLANJ_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/logs';
  const bodyCapBytes = options.bodyCapBytes ?? envInt('FLANJ_BODY_CAP_BYTES');

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

  // Never capture our own export POSTs: ignore the OTLP endpoint's host[:port].
  // Additional ignores may come from FLANJ_IGNORE_URLS (comma-separated substrings/paths).
  const exporterHost = safeUrlHost(endpoint);
  const envIgnore = (process.env.FLANJ_IGNORE_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ignoreUrls = [...(exporterHost ? [exporterHost] : []), ...envIgnore, ...(options.ignoreUrls ?? [])];

  const onCapture = (call: import('./instrumentation/captured-call').CapturedCall): void => emitCall(logger, call);

  // Egress (client) + ingress (server) share one config and one capture sink.
  const instrumentation = new HttpBodyCaptureInstrumentation({
    integration,
    bodyCapBytes,
    ignoreUrls,
    onCapture
  });
  const serverInstrumentation = new HttpServerCaptureInstrumentation({
    integration,
    bodyCapBytes,
    ignoreUrls,
    onCapture
  });

  return {
    loggerProvider,
    instrumentation,
    serverInstrumentation,
    shutdown: async () => {
      instrumentation.disable();
      serverInstrumentation.disable();
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

/** `host[:port]` of a URL, or undefined if unparseable. */
function safeUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

// MCP client instrumentation (v0.5 Step B): wrap the MCP Client — transport-
// independent, out-of-band, both package lines feature-detected as optional peers.
export { instrumentMcpClient } from './mcp/instrument-mcp-client';
export type { InstrumentMcpClientOptions, McpClientLike } from './mcp/instrument-mcp-client';
export { patchMcpClientConstructor, registerMcpAutoInstrumentation } from './mcp/auto-instrument';
export { assembleMcpCall } from './mcp/assemble-mcp-call';
export { assembleContractSnapshot } from './mcp/assemble-contract-snapshot';
export { resolveMcpEdge, UNKNOWN_MCP_SERVER } from './mcp/resolve-mcp-edge';
export type { McpEdge, ResolveMcpEdgeInput } from './mcp/resolve-mcp-edge';
export {
  buildMcpCallAttributes,
  buildContractSnapshotAttributes,
  emitMcpCall,
  emitContractSnapshot
} from './mcp/mcp-record';
export type {
  McpCallMeta,
  McpCapturedCall,
  McpContractSnapshot,
  McpServerIdentity,
  McpServerKind
} from './mcp/mcp-types';

export { HttpBodyCaptureInstrumentation } from './instrumentation/http-body-capture';
export { HttpServerCaptureInstrumentation } from './instrumentation/http-server-capture';
export { classifyHost } from './instrumentation/classify-host';
export type { EdgeClass } from './instrumentation/classify-host';
export { buildLogAttributes, emitCall } from './instrumentation/otlp-record';
export type { CapturedCall } from './instrumentation/captured-call';
export type { HttpBodyCaptureConfig } from './instrumentation/config';

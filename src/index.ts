import { readFileSync, realpathSync } from 'node:fs';
import { LoggerProvider, BatchLogRecordProcessor, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { LogRecordExporter, LogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { Logger } from '@opentelemetry/api-logs';
import { instrumentMcpClient, type InstrumentMcpClientOptions, type McpClientLike } from './mcp/instrument-mcp-client';
import { HttpBodyCaptureInstrumentation } from './instrumentation/http-body-capture';
import { HttpServerCaptureInstrumentation } from './instrumentation/http-server-capture';
import { TrustedProxies } from './instrumentation/trusted-proxies';
import { assertSupportedNodeVersion } from './instrumentation/builtin-module';
import { DEFAULT_BODY_CAP_BYTES } from './instrumentation/config';
import { emitCall } from './instrumentation/otlp-record';
import { resolveOtlpLogsEndpoint } from './otlp-endpoint';
import { withExportFailureWarning } from './export-failure-warning';
import { resolveAppName } from './resolve-app-name';
import { SDK_NAME, SDK_VERSION } from './version';

export interface StartOptions {
  /**
   * `service.name` resource attribute. Env: `OTEL_SERVICE_NAME`. Default order
   * (CONTRACTS §2, 2026-09-19): this option, then `OTEL_SERVICE_NAME`, then the
   * app's own name (nearest `package.json`'s `name`, see `resolveAppName`),
   * then `"flanj-sdk"`. The collector derives every record's integration
   * itself (outbound/MCP: the peer host; inbound: this service name) — the SDK
   * no longer sends an integration id of its own.
   */
  serviceName?: string;
  /**
   * OTLP/HTTP **logs** endpoint. A base URL (no path) is normalized by appending
   * `/v1/logs`; any other path is used as given.
   *
   * Env, in order: `FLANJ_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`,
   * `OTEL_EXPORTER_OTLP_ENDPOINT`. Default `http://localhost:4318/v1/logs`.
   */
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
  /**
   * INGRESS: the reverse proxies / load balancers in front of this service, as
   * IPs or CIDR blocks. `X-Forwarded-For` is believed only from these socket
   * peers, and the caller is then the hop the proxy appended (rightmost
   * untrusted). Env: FLANJ_TRUSTED_PROXIES (comma-separated). Default: none —
   * the header is ignored and the socket peer is the caller, so behind a proxy
   * every inbound call classifies internal (metadata-only) until this is set.
   */
  trustedProxies?: readonly string[];
}

export interface FlanjHandle {
  loggerProvider: LoggerProvider;
  /** Egress (client-path) body-capture instrumentation. */
  instrumentation: HttpBodyCaptureInstrumentation;
  /** Ingress (server-path) body-capture instrumentation. */
  serverInstrumentation: HttpServerCaptureInstrumentation;
  /** The resolved `service.name` resource attribute (see {@link StartOptions.serviceName}). */
  serviceName: string;
  /** The resolved, normalized OTLP/HTTP logs endpoint records are exported to. */
  endpoint: string;
  /**
   * The OTLP logger every captured record is emitted through. Exposed so an MCP
   * client instrumented after `start()` lands in the same pipeline — see
   * {@link FlanjHandle.instrumentMcp}.
   */
  logger: Logger;
  /** The resolved per-body capture cap, in bytes (env `FLANJ_BODY_CAP_BYTES`). */
  bodyCapBytes: number;
  /**
   * Instrument one MCP client with this handle's logger and body cap — the
   * explicit counterpart of the register entry's auto-instrumentation, for a
   * client you hold yourself. The Python SDK's `handle.instrument(session)`.
   *
   * Byte-identical pass-through, like every capture path here: the call is
   * neither delayed nor rewritten.
   */
  instrumentMcp: (client: McpClientLike, options?: InstrumentMcpClientOptions) => void;
  /**
   * Export everything buffered so far and resolve when it has left the process.
   * The batch processor's export timer is `unref`'d with a 1s delay, so a
   * short-lived process **must** flush (or shut down) or it loses its last batch.
   */
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/**
 * Start the Flanj SDK: register the http/https body-capture instrumentation
 * and wire each captured (already-redacted) call to a logs OTLP/HTTP exporter
 * on :4318. Returns a handle for shutdown.
 */
export function start(options: StartOptions = {}): FlanjHandle {
  // FIRST, before any option is read: on a Node without `process.getBuiltinModule`
  // there is nothing to patch, so the SDK is inert. It used to surface as a
  // TypeError from a dist/ path, inside the OTel base constructor; say what is
  // actually wrong, and say it before an exporter or provider exists to leak.
  assertSupportedNodeVersion();

  // `||`, not `??`: an empty option or env var counts as unset (the Python SDK's `or`).
  const serviceName =
    options.serviceName ||
    process.env.OTEL_SERVICE_NAME ||
    resolveAppName({
      argv1: process.argv[1],
      cwd: process.cwd(),
      readFile: (p) => readFileSync(p, 'utf8'),
      realpath: (p) => realpathSync(p)
    });
  const endpoint = resolveOtlpLogsEndpoint(options.otlpEndpoint);
  const bodyCapBytes = options.bodyCapBytes ?? envInt('FLANJ_BODY_CAP_BYTES');
  const trustedProxies = options.trustedProxies ?? envList('FLANJ_TRUSTED_PROXIES');
  // Validate the proxy set FIRST: a bad entry must throw before the egress patch
// and the logger provider exist, or an app that catches the throw and carries
// on keeps capturing every outbound body into an orphan exporter with no
// flush or shutdown path (verified in review).
  new TrustedProxies(trustedProxies);

  // Wrap the exporter so the first export failure is not swallowed: OTel routes
  // export errors to `diag`, and with no diag logger a 404 is zero rows, zero stderr, exit 0.
  const makeExporter = (): LogRecordExporter =>
    withExportFailureWarning(new OTLPLogExporter({ url: endpoint }), endpoint);

  const processor: LogRecordProcessor =
    options.processor ??
    (options.simpleProcessor
      ? new SimpleLogRecordProcessor({ exporter: makeExporter() })
      : new BatchLogRecordProcessor({ exporter: makeExporter() }));

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
    bodyCapBytes,
    ignoreUrls,
    onCapture
  });
  const serverInstrumentation = new HttpServerCaptureInstrumentation({
    bodyCapBytes,
    ignoreUrls,
    trustedProxies,
    onCapture
  });

  return {
    loggerProvider,
    instrumentation,
    serverInstrumentation,
    serviceName,
    endpoint,
    logger,
    bodyCapBytes: bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES,
    instrumentMcp: (client: McpClientLike, mcpOptions: InstrumentMcpClientOptions = {}): void => {
      instrumentMcpClient(client, {
        logger,
        bodyCapBytes: bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES,
        ...mcpOptions
      });
    },
    flush: () => loggerProvider.forceFlush(),
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

/** A comma-separated env list; undefined when unset or blank. */
function envList(key: string): readonly string[] | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
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
export { instrumentMcpClient };
export type { InstrumentMcpClientOptions, McpClientLike };
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
export { SUPPORTED_NODE_RANGE, assertSupportedNodeVersion } from './instrumentation/builtin-module';
export { classifyHost } from './instrumentation/classify-host';
export type { EdgeClass } from './instrumentation/classify-host';
export { buildLogAttributes, emitCall } from './instrumentation/otlp-record';
export type { CapturedCall } from './instrumentation/captured-call';
export type { HttpBodyCaptureConfig } from './instrumentation/config';
export {
  DEFAULT_OTLP_LOGS_ENDPOINT,
  normalizeOtlpLogsEndpoint,
  resolveOtlpLogsEndpoint
} from './otlp-endpoint';

/**
 * OTLP/HTTP **logs** endpoint resolution.
 *
 * The OTel exporter appends the `v1/logs` resource path only on the
 * `OTEL_EXPORTER_OTLP_ENDPOINT` environment path — never for a URL passed
 * explicitly as `new OTLPLogExporter({ url })`. A base URL such as
 * `http://localhost:4318` therefore POSTs to `/`, the collector answers 404,
 * and (with no diag logger registered) the process exits 0 having shipped
 * nothing. The sibling knob FLANJ_STORE_ENDPOINT *does* take a base URL, so
 * that value is a natural guess — normalize it instead of silently losing data.
 */

/** Where the collector listens by default (OTLP/HTTP logs). */
export const DEFAULT_OTLP_LOGS_ENDPOINT = 'http://localhost:4318/v1/logs';

/** The OTLP/HTTP resource path for the logs signal. */
const LOGS_RESOURCE_PATH = '/v1/logs';

/**
 * Append `/v1/logs` to a **base** URL; leave any explicit path alone.
 *
 *   http://localhost:4318          -> http://localhost:4318/v1/logs
 *   http://localhost:4318/         -> http://localhost:4318/v1/logs
 *   http://localhost:4318/v1/logs  -> unchanged
 *   https://otlp.example.com/ingest/v1/logs -> unchanged (custom path)
 *
 * An unparseable value is returned verbatim: the exporter owns that error, and
 * rewriting garbage would only obscure it.
 */
export function normalizeOtlpLogsEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }

  if (url.pathname !== '' && url.pathname !== '/') return endpoint;

  url.pathname = LOGS_RESOURCE_PATH;
  return url.href;
}

/**
 * Resolve the logs endpoint from an explicit option, then the environment,
 * then the default — and normalize whatever wins.
 *
 * Precedence: `explicit` -> `FLANJ_OTLP_ENDPOINT` ->
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` -> `OTEL_EXPORTER_OTLP_ENDPOINT` ->
 * {@link DEFAULT_OTLP_LOGS_ENDPOINT}. The two `OTEL_*` names are the standard
 * OTel knobs; honouring them here keeps a host already configured for OTLP
 * working without a Flanj-specific variable. Blank values count as unset.
 */
export function resolveOtlpLogsEndpoint(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw =
    firstNonBlank(
      explicit,
      env.FLANJ_OTLP_ENDPOINT,
      env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      env.OTEL_EXPORTER_OTLP_ENDPOINT
    ) ?? DEFAULT_OTLP_LOGS_ENDPOINT;

  return normalizeOtlpLogsEndpoint(raw);
}

function firstNonBlank(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

import type { InstrumentationConfig } from '@opentelemetry/instrumentation';
import type { CapturedCall } from './captured-call';

/** Default body capture cap in bytes (contract key `body_cap_bytes`). */
export const DEFAULT_BODY_CAP_BYTES = 16384;

/**
 * Content-type prefixes eligible for body capture. Anything else (binary,
 * multipart file uploads, octet-stream, …) captures NO body.
 */
export const DEFAULT_CAPTURE_CONTENT_TYPES: readonly string[] = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/'
];

export interface HttpBodyCaptureConfig extends InstrumentationConfig {
  /** Integration id emitted as `vinifera.integration`, e.g. `acme-payments`. */
  integration: string;
  /** Body capture cap in bytes. Default {@link DEFAULT_BODY_CAP_BYTES}. */
  bodyCapBytes?: number;
  /** Content-type prefixes to capture. Default {@link DEFAULT_CAPTURE_CONTENT_TYPES}. */
  captureContentTypes?: readonly string[];
  /** Header allowlist. Default from `@vinifera/redaction-patterns`. */
  headerAllowlist?: readonly string[];
  /**
   * Full-URL ignore matchers. A request whose `${protocol}//${host}${path}`
   * matches is NOT captured. Strings match by substring; RegExps by `.test()`.
   * `start()` seeds this with the collector's own OTLP endpoint host so the SDK
   * never captures its own export POSTs (which would create an unbounded
   * capture→export→capture feedback loop against a co-located collector).
   */
  ignoreUrls?: readonly (string | RegExp)[];
  /** Sink for each completed, redacted call. Wired to the OTLP logger by start(). */
  onCapture?: (call: CapturedCall) => void;
}

/** True when `fullUrl` matches any ignore matcher (substring for strings, test for RegExps). */
export function isIgnoredUrl(fullUrl: string, matchers: readonly (string | RegExp)[] | undefined): boolean {
  if (!matchers || matchers.length === 0) return false;
  return matchers.some((m) => (typeof m === 'string' ? fullUrl.includes(m) : m.test(fullUrl)));
}

/** True when a content-type header value is eligible for body capture. */
export function isCaptureableContentType(contentType: string | undefined, allowed: readonly string[]): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return allowed.some((prefix) => lower.startsWith(prefix));
}

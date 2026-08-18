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
  /** Sink for each completed, redacted call. Wired to the OTLP logger by start(). */
  onCapture?: (call: CapturedCall) => void;
}

/** True when a content-type header value is eligible for body capture. */
export function isCaptureableContentType(contentType: string | undefined, allowed: readonly string[]): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return allowed.some((prefix) => lower.startsWith(prefix));
}

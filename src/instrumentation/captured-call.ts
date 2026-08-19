import type { PatternId } from '@vinifera/redaction-patterns';

/**
 * A single completed HTTP client call, fully redacted at source. This is the
 * internal hand-off from {@link HttpBodyCaptureInstrumentation} to
 * {@link buildLogRecord}. It NEVER contains a raw body — the raw capture buffer
 * is redacted and dropped before a `CapturedCall` is constructed.
 */
export interface CapturedCall {
  integration: string;
  direction: 'client' | 'server';
  /** The OTHER end's host[:port] — egress: destination; ingress: caller/source. The edge key. */
  peerHost: string;
  /** SDK classification of {@link peerHost}. */
  edgeClass: 'external' | 'internal';
  /** `true` when bodies are present (external edge); `false` when metadata-only (internal). */
  captureBodies: boolean;
  method: string;
  route: string;
  target: string;
  urlFull: string;
  statusCode: number;
  requestContentType?: string;
  requestBody: string; // redacted
  requestBodyTruncated: boolean;
  requestHeaders: Record<string, string>; // redacted + allowlisted
  responseContentType?: string;
  responseBody: string; // redacted
  responseBodyTruncated: boolean;
  responseHeaders: Record<string, string>; // redacted + allowlisted
  correlation: {
    requestId?: string;
    idempotencyKey?: string;
    traceId?: string;
    spanId?: string;
  };
  durationMs: number;
  redactionApplied: boolean;
  redactionPatterns: PatternId[];
  redactionSpecAware: boolean;
}

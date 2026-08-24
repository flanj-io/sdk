import type { PatternId, RedactedField } from '@vinifera/redaction-patterns';

/**
 * One whole-value body redaction, scoped to which body it happened in. Carries the
 * ORIGINAL value's non-reversible properties (type/length/charset) so the collector's
 * drift detector can still validate the decidable spec constraints of redacted fields.
 */
export interface WireRedactedField extends RedactedField {
  part: 'request' | 'response';
}

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
  /**
   * The peer's socket address (IP) when known — egress: the resolved remote
   * address; ingress: `socket.remoteAddress`. Transport detail for display and
   * debugging; NEVER an identity or edge key (IPs churn, NAT/LBs collapse them).
   */
  peerAddr?: string;
  /**
   * SDK classification of {@link peerHost}. HTTP peers classify `external` |
   * `internal` (classify-host heuristic); a stdio MCP server is the additive
   * v0.5 class `local-process` (CONTRACTS §2 `vinifera.edge.class`).
   */
  edgeClass: 'external' | 'internal' | 'local-process';
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
  /** Whole-value body redactions with captured properties (CONTRACTS §2/§6); often empty. */
  redactionFields: WireRedactedField[];
}

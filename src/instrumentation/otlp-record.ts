import { SeverityNumber, type LogAttributes, type Logger } from '@opentelemetry/api-logs';
import { CAPTURE_VERSION } from '../version';
import { CapturedCall } from './captured-call';

/**
 * Map a redacted {@link CapturedCall} to the frozen `flanj.*` OTLP log-record
 * attribute convention (CONTRACTS §2). Only redacted values are ever placed
 * here; there is no code path from a raw body to these attributes.
 */
export function buildLogAttributes(call: CapturedCall): LogAttributes {
  const attrs: LogAttributes = {
    'flanj.capture.version': CAPTURE_VERSION,
    'flanj.record.type': 'call',
    'flanj.direction': call.direction,
    'flanj.peer.host': call.peerHost,
    'flanj.edge.class': call.edgeClass,
    'flanj.capture.bodies': call.captureBodies,
    'flanj.integration': call.integration,
    'flanj.http.method': call.method,
    'flanj.http.route': call.route,
    'flanj.http.target': call.target,
    'flanj.http.url.full': call.urlFull,
    'flanj.http.status_code': call.statusCode,
    'flanj.http.request.body': call.requestBody,
    'flanj.http.request.body.truncated': call.requestBodyTruncated,
    'flanj.http.request.headers': JSON.stringify(call.requestHeaders),
    'flanj.http.response.body': call.responseBody,
    'flanj.http.response.body.truncated': call.responseBodyTruncated,
    'flanj.http.response.headers': JSON.stringify(call.responseHeaders),
    'flanj.http.duration_ms': call.durationMs,
    'flanj.redaction.applied': call.redactionApplied,
    'flanj.redaction.patterns': JSON.stringify(call.redactionPatterns),
    'flanj.redaction.spec_aware': call.redactionSpecAware
  };

  if (call.redactionFields.length > 0) {
    // Optional attr (omitted when empty, like content_type/corr.*): whole-value body
    // redactions with the originals' captured properties — drift's evidence for
    // validating redacted fields (CONTRACTS §2/§6).
    attrs['flanj.redaction.fields'] = JSON.stringify(call.redactionFields);
  }
  // Optional: the peer's socket address (IP) — transport detail alongside the
  // peer.host identity; omitted when the socket layer did not expose one.
  if (call.peerAddr) attrs['flanj.peer.addr'] = call.peerAddr;
  if (call.requestContentType) attrs['flanj.http.request.content_type'] = call.requestContentType;
  if (call.responseContentType) attrs['flanj.http.response.content_type'] = call.responseContentType;
  if (call.correlation.requestId) attrs['flanj.corr.request_id'] = call.correlation.requestId;
  if (call.correlation.idempotencyKey) attrs['flanj.corr.idempotency_key'] = call.correlation.idempotencyKey;
  if (call.correlation.traceId) attrs['flanj.corr.trace_id'] = call.correlation.traceId;
  if (call.correlation.spanId) attrs['flanj.corr.span_id'] = call.correlation.spanId;

  return attrs;
}

/**
 * Emit one OTLP log record for a completed call. The record body is empty; all
 * data lives in the `flanj.*` attributes (carrier-agnostic convention).
 */
export function emitCall(logger: Logger, call: CapturedCall): void {
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: '',
    attributes: buildLogAttributes(call)
  });
}

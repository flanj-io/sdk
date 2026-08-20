import { SeverityNumber, type LogAttributes, type Logger } from '@opentelemetry/api-logs';
import { CAPTURE_VERSION } from '../version';
import { CapturedCall } from './captured-call';

/**
 * Map a redacted {@link CapturedCall} to the frozen `vinifera.*` OTLP log-record
 * attribute convention (CONTRACTS §2). Only redacted values are ever placed
 * here; there is no code path from a raw body to these attributes.
 */
export function buildLogAttributes(call: CapturedCall): LogAttributes {
  const attrs: LogAttributes = {
    'vinifera.capture.version': CAPTURE_VERSION,
    'vinifera.record.type': 'call',
    'vinifera.direction': call.direction,
    'vinifera.peer.host': call.peerHost,
    'vinifera.edge.class': call.edgeClass,
    'vinifera.capture.bodies': call.captureBodies,
    'vinifera.integration': call.integration,
    'vinifera.http.method': call.method,
    'vinifera.http.route': call.route,
    'vinifera.http.target': call.target,
    'vinifera.http.url.full': call.urlFull,
    'vinifera.http.status_code': call.statusCode,
    'vinifera.http.request.body': call.requestBody,
    'vinifera.http.request.body.truncated': call.requestBodyTruncated,
    'vinifera.http.request.headers': JSON.stringify(call.requestHeaders),
    'vinifera.http.response.body': call.responseBody,
    'vinifera.http.response.body.truncated': call.responseBodyTruncated,
    'vinifera.http.response.headers': JSON.stringify(call.responseHeaders),
    'vinifera.http.duration_ms': call.durationMs,
    'vinifera.redaction.applied': call.redactionApplied,
    'vinifera.redaction.patterns': JSON.stringify(call.redactionPatterns),
    'vinifera.redaction.spec_aware': call.redactionSpecAware
  };

  if (call.redactionFields.length > 0) {
    // Optional attr (omitted when empty, like content_type/corr.*): whole-value body
    // redactions with the originals' captured properties — drift's evidence for
    // validating redacted fields (CONTRACTS §2/§6).
    attrs['vinifera.redaction.fields'] = JSON.stringify(call.redactionFields);
  }
  if (call.requestContentType) attrs['vinifera.http.request.content_type'] = call.requestContentType;
  if (call.responseContentType) attrs['vinifera.http.response.content_type'] = call.responseContentType;
  if (call.correlation.requestId) attrs['vinifera.corr.request_id'] = call.correlation.requestId;
  if (call.correlation.idempotencyKey) attrs['vinifera.corr.idempotency_key'] = call.correlation.idempotencyKey;
  if (call.correlation.traceId) attrs['vinifera.corr.trace_id'] = call.correlation.traceId;
  if (call.correlation.spanId) attrs['vinifera.corr.span_id'] = call.correlation.spanId;

  return attrs;
}

/**
 * Emit one OTLP log record for a completed call. The record body is empty; all
 * data lives in the `vinifera.*` attributes (carrier-agnostic convention).
 */
export function emitCall(logger: Logger, call: CapturedCall): void {
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: '',
    attributes: buildLogAttributes(call)
  });
}

import {
  redactDetailed,
  redactHeaders,
  DEFAULT_HEADER_ALLOWLIST,
  REPORT_ORDER,
  type PatternId,
  type RedactedField
} from '@vinifera/redaction-patterns';
import { CapturedCall, WireRedactedField } from './captured-call';
import { DEFAULT_CAPTURE_CONTENT_TYPES, isCaptureableContentType } from './config';
import type { EdgeClass } from './classify-host';

type HeaderValue = string | string[] | number | undefined;

/**
 * The direction-agnostic inputs needed to build a fully-redacted
 * {@link CapturedCall}. Bodies are handed in as ALREADY-DECODED strings (the
 * decoded capped buffer); this function redacts them at source. Raw buffers must
 * be dropped by the caller the moment this returns.
 */
export interface AssembleCallInput {
  integration: string;
  direction: 'client' | 'server';
  peerHost: string;
  /** The peer's socket address (IP) when known; transport detail, not identity. */
  peerAddr?: string;
  edgeClass: EdgeClass;
  /** `true` only for external edges — internal edges are metadata-only. */
  captureBodies: boolean;
  method: string;
  protocol: string;
  host: string;
  path: string;
  statusCode: number;
  reqContentType?: string;
  resContentType?: string;
  reqBodyRaw: string;
  reqBodyTruncated: boolean;
  resBodyRaw: string;
  resBodyTruncated: boolean;
  requestHeaders: Record<string, HeaderValue>;
  responseHeaders: Record<string, HeaderValue>;
  correlation: { requestId?: string; idempotencyKey?: string; traceId?: string; spanId?: string };
  durationMs: number;
  captureContentTypes?: readonly string[];
  headerAllowlist?: readonly string[];
}

/**
 * Redact at source and assemble a {@link CapturedCall}. Bodies are redacted-and-kept
 * ONLY when `captureBodies` is true (external edge) AND the content-type is
 * captureable. Internal edges keep NO body at all — there is nothing to leak
 * because the raw bytes were never teed. Target/URL are always redacted (they
 * are metadata, and the redaction floor covers everything captured).
 */
export function assembleCapturedCall(input: AssembleCallInput): CapturedCall {
  const contentTypes = input.captureContentTypes ?? DEFAULT_CAPTURE_CONTENT_TYPES;
  const allowlist = input.headerAllowlist ?? DEFAULT_HEADER_ALLOWLIST;

  const captureReq = input.captureBodies && isCaptureableContentType(input.reqContentType, contentTypes);
  const captureRes = input.captureBodies && isCaptureableContentType(input.resContentType, contentTypes);

  const empty = { text: '', patterns: [] as PatternId[], fields: [] as RedactedField[] };
  const reqRedaction = captureReq ? redactDetailed(input.reqBodyRaw) : empty;
  const resRedaction = captureRes ? redactDetailed(input.resBodyRaw) : empty;

  const targetRedaction = redactDetailed(input.path);
  const urlRedaction = redactDetailed(`${input.protocol}//${input.host}${input.path}`);

  const firedPatterns = new Set<PatternId>();
  for (const p of [
    ...reqRedaction.patterns,
    ...resRedaction.patterns,
    ...targetRedaction.patterns,
    ...urlRedaction.patterns
  ]) {
    firedPatterns.add(p);
  }
  const patterns = REPORT_ORDER.filter((id) => firedPatterns.has(id));

  // Whole-value body redactions, with the original values' captured properties (already
  // sorted by path per part; request precedes response). Target/URL redactions carry no
  // fields — specs don't address redacted URL text.
  const redactionFields: WireRedactedField[] = [
    ...reqRedaction.fields.map((f): WireRedactedField => ({ part: 'request', ...f })),
    ...resRedaction.fields.map((f): WireRedactedField => ({ part: 'response', ...f }))
  ];

  return {
    integration: input.integration,
    direction: input.direction,
    peerHost: input.peerHost,
    peerAddr: input.peerAddr,
    edgeClass: input.edgeClass,
    captureBodies: input.captureBodies,
    method: input.method,
    route: targetRedaction.text,
    target: targetRedaction.text,
    urlFull: urlRedaction.text,
    statusCode: input.statusCode,
    requestContentType: input.reqContentType,
    requestBody: reqRedaction.text,
    requestBodyTruncated: captureReq ? input.reqBodyTruncated : false,
    requestHeaders: redactHeaders(input.requestHeaders, allowlist),
    responseContentType: input.resContentType,
    responseBody: resRedaction.text,
    responseBodyTruncated: captureRes ? input.resBodyTruncated : false,
    responseHeaders: redactHeaders(input.responseHeaders, allowlist),
    correlation: input.correlation,
    durationMs: input.durationMs,
    redactionApplied: patterns.length > 0,
    redactionPatterns: patterns,
    redactionSpecAware: false,
    redactionFields
  };
}

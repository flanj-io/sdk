import {
  redactDetailed,
  redactHeaders,
  DEFAULT_HEADER_ALLOWLIST,
  REPORT_ORDER,
  type PatternId,
  type RedactedField
} from '@flanj/redaction-patterns';
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
  direction: 'client' | 'server';
  peerHost: string;
  /** The peer's socket address (IP) when known; transport detail, not identity. */
  peerAddr?: string;
  edgeClass: EdgeClass | 'local-process';
  /** `true` only for external edges — internal edges are metadata-only. */
  captureBodies: boolean;
  method: string;
  protocol: string;
  host: string;
  /** Path + query, as dialled. Becomes `target` whole, and `route` up to the query. */
  path: string;
  /**
   * `true` when `path` is an opaque name rather than a URL path+query — MCP's
   * `/<tool.name>`, where a `?` or `#` is part of the name — so `route` is the
   * whole redacted path. Default `false`: `route` stops at the first `?` or `#`.
   */
  opaquePath?: boolean;
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
 * The path of an ALREADY-REDACTED path+query: everything before the first `?` or
 * `#` (RFC 3986 §3.3). CONTRACTS §2: `route` is the path, `target` is path+query.
 *
 * Cut AFTER redaction, never before. What the floor does with a path segment can
 * depend on the query beside it — `/pay/cvv=123?x=1` has the value tokenised,
 * the bare `/pay/cvv=123` does not — so redacting a pre-cut path could put a
 * value in `route` that `target` hid. Cutting the redacted text makes `route` a
 * prefix of `target`: it can never show more. A redaction token contains neither
 * delimiter, so the cut cannot land inside one.
 *
 * An empty path is `/` (RFC 3986 §6.2.3), never `''` — a record with an empty
 * route is discarded downstream as not-a-call.
 */
function pathOf(redactedTarget: string): string {
  const end = redactedTarget.search(/[?#]/);
  const path = end === -1 ? redactedTarget : redactedTarget.slice(0, end);
  return path === '' ? '/' : path;
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
    direction: input.direction,
    peerHost: input.peerHost,
    peerAddr: input.peerAddr,
    edgeClass: input.edgeClass,
    captureBodies: input.captureBodies,
    method: input.method,
    // No redaction pass of its own: `route` is a slice of `target`, so every token
    // in it is already counted in `patterns` through `targetRedaction`.
    route: input.opaquePath ? targetRedaction.text : pathOf(targetRedaction.text),
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

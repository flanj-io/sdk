import { findBase64Runs } from './base64';
import type { Recognizer, ScanContext, Span } from './recognizer';
import { REPORT_ORDER } from './report-order';
import { makeToken, TOKEN_CLOSE, TOKEN_OPEN, type PatternId } from './tokens';

export interface ScalarResult {
  value: string;
  /** Pattern ids that fired on THIS scalar (unordered). */
  fired: Set<PatternId>;
}

/** Matches any already-emitted token; such spans are protected and never re-scanned. */
const TOKEN_RE = new RegExp(`${TOKEN_OPEN}REDACTED:[A-Z0-9_]+${TOKEN_CLOSE}`, 'g');

/** Replace `spans` (sorted, non-overlapping) in `text` with `token`. */
function splice(text: string, spans: Span[], token: string): string {
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    out += text.slice(cursor, s.start) + token;
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

/** Defensive normalisation: sort by start and drop overlaps (first wins). */
function normalise(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    if (s.end <= s.start) continue;
    const last = out[out.length - 1];
    if (last && s.start < last.end) continue;
    out.push(s);
  }
  return out;
}

/** Run the recognizers sequentially over one token-free segment. */
function applyRecognizers(
  segment: string,
  ctx: ScanContext,
  recognizers: readonly Recognizer[],
  fired: Set<PatternId>
): string {
  let text = segment;
  for (const rec of recognizers) {
    const spans = normalise(rec.find(text, ctx));
    if (spans.length === 0) continue;
    fired.add(rec.id);
    text = splice(text, spans, makeToken(rec.id));
  }
  return text;
}

/** Decode-then-scan every base64 run; on a hit the WHOLE run becomes one token. */
function applyBase64(segment: string, recognizers: readonly Recognizer[], fired: Set<PatternId>): string {
  const runs = findBase64Runs(segment);
  if (runs.length === 0) return segment;
  let out = '';
  let cursor = 0;
  for (const run of runs) {
    const inner = new Set<PatternId>();
    applyRecognizers(run.decoded, {}, recognizers, inner);
    if (inner.size === 0) continue;
    const first = REPORT_ORDER.find((id) => inner.has(id))!;
    for (const id of inner) fired.add(id);
    out += segment.slice(cursor, run.start) + makeToken(first);
    cursor = run.end;
  }
  return out + segment.slice(cursor);
}

/**
 * The per-scalar engine: protects existing tokens (idempotency / never double-wrap),
 * runs the recognizers in application order over each unprotected segment, then the
 * base64 decode-then-scan pass. Everything structural above this (objects, arrays, JSON
 * text, forms) funnels every scalar through here, so one scalar contract serves all
 * entry points — and the Go collector implements the identical function.
 */
export function redactScalar(value: string, ctx: ScanContext, recognizers: readonly Recognizer[]): ScalarResult {
  const fired = new Set<PatternId>();
  if (value.length === 0) return { value, fired };
  const re = new RegExp(TOKEN_RE.source, 'g');
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  const scan = (seg: string): string => (seg.length === 0 ? seg : applyBase64(applyRecognizers(seg, ctx, recognizers, fired), recognizers, fired));
  while ((m = re.exec(value)) !== null) {
    out += scan(value.slice(cursor, m.index)) + m[0];
    cursor = m.index + m[0].length;
  }
  out += scan(value.slice(cursor));
  return { value: out, fired };
}

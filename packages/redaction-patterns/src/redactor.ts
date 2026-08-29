import { classifyIntegerDigits, integerDigitsOf } from './numbers';
import { computeProps, escapePointerSegment, sortFields, wholeTokenId, type RedactedField } from './props';
import type { Recognizer, ScanContext } from './recognizer';
import { DEFAULT_RECOGNIZERS, OPTIONAL_IP_RECOGNIZER } from './recognizers/index';
import { REPORT_ORDER } from './report-order';
import { redactScalar } from './scalar';
import { redactTextPath } from './text-path';
import { makeToken, type PatternId } from './tokens';

/** Result of the structural entry point. */
export interface RedactValueResult {
  /** A redacted deep clone; the input is never mutated. */
  redacted: unknown;
  /** Which pattern ids fired, in canonical report order (deduped). */
  hits: PatternId[];
  /** Whole-value redactions with the original's captured properties, sorted by path. */
  fields: RedactedField[];
}

/** Result of the text entry point (the shape the SDK and control plane consume). */
export interface RedactResult {
  /** The redacted text; every sensitive value replaced by a `⟦REDACTED:…⟧` token. */
  text: string;
  /** Which pattern ids fired, in canonical report order (deduped). */
  patterns: PatternId[];
  /** Whole-value redactions with the original's captured properties, sorted by path. */
  fields: RedactedField[];
}

/**
 * The Flanj redaction floor behind one swappable interface (mirrored by the Go
 * collector's `redact.Redactor`):
 *  - `redact(value)` recurses ARBITRARY nested structures (objects, arrays, scalars) and
 *    returns a redacted clone plus the patterns that fired. Every string — keys included,
 *    undocumented fields included — goes through the per-scalar engine; numbers/bools/null
 *    are untouched except a PAN-as-number or a CVV-under-key, which become string tokens.
 *  - `redactText(text)` is the production path for captured BODIES: JSON is scanned in
 *    place (only fired scalars rewritten), forms are decoded-then-scanned, anything else is
 *    one scalar. Byte-identical to the Go collector for the same input.
 * Both report `fields`: for every WHOLE-VALUE redaction (the scalar became exactly one
 * token) the RFC 6901 path, the pattern, and the original's non-reversible properties —
 * so drift detection downstream can still judge type/length of redacted fields. Span-in-
 * text redactions, redacted keys, form pairs and non-JSON text emit no fields.
 */
export interface Redactor {
  redact(value: unknown): RedactValueResult;
  redactText(text: string): RedactResult;
}

export interface RedactorOptions {
  /** Replace the default recognizer set (APPLICATION order). Engine choice is per-recognizer. */
  recognizers?: readonly Recognizer[];
  /** Enable the optional IP recognizer (off by default — it over-redacts peer hosts). */
  includeIp?: boolean;
}

/** Build a redactor. The default set is the mandatory floor. */
export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const base = opts.recognizers ?? DEFAULT_RECOGNIZERS;
  const recognizers: readonly Recognizer[] = opts.includeIp ? [...base, OPTIONAL_IP_RECOGNIZER] : base;

  const walk = (
    value: unknown,
    ctx: ScanContext,
    path: string,
    fired: Set<PatternId>,
    fields: RedactedField[]
  ): unknown => {
    if (typeof value === 'string') {
      const r = redactScalar(value, ctx, recognizers);
      for (const id of r.fired) fired.add(id);
      if (r.value !== value) {
        const id = wholeTokenId(r.value);
        if (id) fields.push({ path, pattern: id, props: computeProps(value, 'string') });
      }
      return r.value;
    }
    if (typeof value === 'number') {
      const digits = integerDigitsOf(value);
      const id = digits === null ? null : classifyIntegerDigits(digits, ctx.key);
      if (id) {
        fired.add(id);
        fields.push({ path, pattern: id, props: computeProps(String(value), 'number', true) });
        return makeToken(id);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => walk(v, {}, `${path}/${i}`, fired, fields));
    }
    if (value !== null && typeof value === 'object') {
      // Plain objects (JSON-derived). Non-plain objects (Map/Set/Date/Buffer) expose no own
      // enumerable entries and collapse to {} — fail-safe: nothing leaks, nothing is kept.
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Redacted KEYS carry no field record — a key is not a spec-addressable value.
        const kr = redactScalar(k, {}, recognizers);
        for (const id of kr.fired) fired.add(id);
        out[kr.value] = walk(v, { key: k }, `${path}/${escapePointerSegment(k)}`, fired, fields);
      }
      return out;
    }
    return value; // boolean, null, undefined, bigint, symbol, function: untouched
  };

  return {
    redact(value: unknown): RedactValueResult {
      const fired = new Set<PatternId>();
      const fields: RedactedField[] = [];
      const redacted = walk(value, {}, '', fired, fields);
      return { redacted, hits: REPORT_ORDER.filter((id) => fired.has(id)), fields: sortFields(fields) };
    },
    redactText(text: string): RedactResult {
      const r = redactTextPath(text, recognizers);
      return {
        text: r.text,
        patterns: REPORT_ORDER.filter((id) => r.fired.has(id)),
        fields: sortFields(r.fields)
      };
    }
  };
}

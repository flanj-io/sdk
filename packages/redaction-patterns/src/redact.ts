import { PATTERNS } from './patterns';
import { REPORT_ORDER } from './report-order';
import { PatternId } from './tokens';

export interface RedactResult {
  /** The redacted text; every sensitive value replaced by a `⟦REDACTED:…⟧` token. */
  text: string;
  /** Which pattern ids fired, in canonical report order (deduped). */
  patterns: PatternId[];
}

/**
 * Redact sensitive values from free text, returning the redacted text and the
 * set of fired pattern ids. Invariants (governed by contracts/redaction-vectors.json):
 *  - add-only: only replaces sensitive spans, never un-redacts;
 *  - idempotent: redactDetailed(redactDetailed(x).text).text === redactDetailed(x).text.
 */
export function redactDetailed(input: string): RedactResult {
  let text = input;
  const fired = new Set<PatternId>();
  for (const pattern of PATTERNS) {
    const next = pattern.apply(text);
    if (next !== text) fired.add(pattern.id);
    text = next;
  }
  const patterns = REPORT_ORDER.filter((id) => fired.has(id));
  return { text, patterns };
}

/**
 * Redact sensitive values from free text. Primary entry point.
 * Idempotent and add-only. Safe to run over already-redacted text.
 */
export function redact(input: string): string {
  return redactDetailed(input).text;
}

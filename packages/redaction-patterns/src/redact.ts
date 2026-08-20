import { createRedactor, type RedactResult, type Redactor } from './redactor';

/** The default floor: every mandatory recognizer, IP off. Built once per process. */
let defaultRedactor: Redactor | undefined;

function floor(): Redactor {
  if (!defaultRedactor) defaultRedactor = createRedactor();
  return defaultRedactor;
}

/**
 * Redact sensitive values from a captured body / free text, returning the redacted text
 * and the set of fired pattern ids. This is the TEXT entry point of the default floor
 * (see {@link createRedactor} for the structural entry point and custom recognizer sets).
 * Invariants (governed by contracts/redaction-vectors.json + redaction-fixtures.json):
 *  - add-only: only replaces sensitive spans, never un-redacts;
 *  - idempotent: redactDetailed(redactDetailed(x).text).text === redactDetailed(x).text;
 *  - zero I/O: pure function of its input.
 */
export function redactDetailed(input: string): RedactResult {
  return floor().redactText(input);
}

/**
 * Redact sensitive values from text. Primary convenience entry point.
 * Idempotent and add-only. Safe to run over already-redacted text.
 */
export function redact(input: string): string {
  return redactDetailed(input).text;
}

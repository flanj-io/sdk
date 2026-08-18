/**
 * Redaction token format. Delimiters are U+27E6 / U+27E7 (⟦ ⟧) — regex-stable,
 * won't collide with JSON/text, and make emitted tokens inert to re-scanning.
 */
export const TOKEN_OPEN = '⟦';
export const TOKEN_CLOSE = '⟧';

export type PatternId = 'PAN' | 'EMAIL' | 'IBAN' | 'SSN' | 'PHONE' | 'CVV' | 'TOKEN' | 'IP';

export function makeToken(type: PatternId): string {
  return `${TOKEN_OPEN}REDACTED:${type}${TOKEN_CLOSE}`;
}

/**
 * Matches any already-emitted redaction token, e.g. ⟦REDACTED:PAN⟧.
 * Used to prove idempotency invariants; never used to un-redact.
 */
export const REDACTED_TOKEN_RE = new RegExp(`${TOKEN_OPEN}REDACTED:[A-Z]+${TOKEN_CLOSE}`, 'g');

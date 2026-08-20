import { passesLuhn } from './luhn';
import { isCvvKey } from './recognizers/cvv';
import { isDigitAt } from './chars';
import type { PatternId } from './tokens';

/**
 * The two cases in which a NUMBER (a JSON number literal on the text path, or a number
 * value on the structural path) is redacted — everything else numeric is left untouched:
 *  - a 3–4 digit integer under a CVV key  -> CVV;
 *  - a 13–19 digit integer that passes Luhn -> PAN (a PAN sent as a bare number).
 * `digits` is the literal's digit string (sign, fraction and exponent make it not an
 * integer => never redacted). Returns the pattern that fires, or null.
 */
export function classifyIntegerDigits(digits: string, key: string | undefined): PatternId | null {
  if (digits.length === 0) return null;
  for (let i = 0; i < digits.length; i++) if (!isDigitAt(digits, i)) return null;
  if (digits.length >= 3 && digits.length <= 4 && isCvvKey(key)) return 'CVV';
  if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return 'PAN';
  return null;
}

/** Digit string of a JS number when it is a safe-to-print integer; null otherwise. */
export function integerDigitsOf(n: number): string | null {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e21) return null; // String() would switch to exponent form
  return String(abs);
}

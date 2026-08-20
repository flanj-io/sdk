import isLuhnNumber from 'validator/lib/isLuhnNumber';

/**
 * Luhn (mod-10) gate for candidate PANs, delegated to the `validator` library's
 * hardened implementation. Input must be digits only (the caller has already stripped
 * separators). This is the ONLY thing that turns a 13–19 digit run into a PAN hit —
 * the floor is Luhn-gated, never brand/BIN-gated (BIN tables differ between libraries
 * and reject real 19-digit and regional cards; Luhn is a fixed function, so the Go
 * collector and this package agree forever).
 */
export function passesLuhn(digits: string): boolean {
  if (digits.length === 0) return false;
  for (let i = 0; i < digits.length; i++) {
    const c = digits.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return isLuhnNumber(digits);
}

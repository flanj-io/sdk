import { isValidPhoneNumber } from 'libphonenumber-js/max';
import { isDigitAt, isWordCharAt, charAt } from '../chars';
import type { Recognizer, Span } from '../recognizer';

/** E.164 bounds: at most 15 digits; below 5 nothing validates anywhere. */
const MAX_DIGITS = 15;
const MIN_DIGITS = 5;
const MAX_GROUPS = 8;

/**
 * Phone recognizer — INTERNATIONAL numbers only (`+` country code), in common separated
 * formats: `+14155552671`, `+1 415 555 2671`, `+1 (415) 555-2671`, `+49.30.901820`.
 * Our code LOCATES `+` followed by digit groups joined by single ` `/`.`/`-` and optional
 * parentheses; `libphonenumber-js` (full `max` metadata, to match the Go `phonenumbers`
 * port) DECIDES validity. Candidates are tried longest-first, dropping trailing groups
 * (so `+1 415 555 2671 1225` finds the number and spares the 1225).
 *
 * National formats without `+` are NOT redacted: without a region they cannot be
 * validated, and a loose phone regex is precisely what re-caught Luhn-spared ids.
 */
export const PHONE_RECOGNIZER: Recognizer = {
  id: 'PHONE',
  find(text: string): Span[] {
    const spans: Span[] = [];
    let i = 0;
    while (i < text.length) {
      if (charAt(text, i) !== '+' || !isDigitAt(text, i + 1) || isWordCharAt(text, i - 1)) {
        i++;
        continue;
      }
      // Collect digit groups. `ends[g]` is the index just past group g (and its `)` if any).
      const ends: number[] = [];
      const counts: number[] = [];
      let pos = i + 1;
      let digits = 0;
      for (;;) {
        const save = pos;
        if (ends.length > 0) {
          const sep = charAt(text, pos);
          if (sep === ' ' || sep === '.' || sep === '-') pos++;
        }
        let paren = false;
        if (charAt(text, pos) === '(') {
          pos++;
          paren = true;
        }
        if (!isDigitAt(text, pos)) {
          pos = save;
          break;
        }
        const start = pos;
        while (isDigitAt(text, pos)) pos++;
        const n = pos - start;
        digits += n;
        if (paren && charAt(text, pos) === ')') pos++;
        ends.push(pos);
        counts.push(n);
        if (digits > MAX_DIGITS || ends.length >= MAX_GROUPS) break;
      }
      let matched = false;
      let total = digits;
      for (let e = ends.length - 1; e >= 0; e--) {
        if (e < ends.length - 1) total -= counts[e + 1]!;
        if (total < MIN_DIGITS) break;
        const end = ends[e]!;
        if (total > MAX_DIGITS || isWordCharAt(text, end)) continue;
        const candidate = text.slice(i, end);
        if (isValidPhoneNumber(candidate)) {
          spans.push({ start: i, end });
          i = end;
          matched = true;
          break;
        }
      }
      if (!matched) i++;
    }
    return spans;
  }
};

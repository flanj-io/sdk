import isIBAN from 'validator/lib/isIBAN';
import { isAlnumAt, isDigitAt, isLetterAt, isWordCharAt, charAt } from '../chars';
import type { Recognizer, Span } from '../recognizer';

/** ISO 13616 length bounds of the stripped (separator-free) IBAN. */
const MIN_LEN = 15;
const MAX_LEN = 34;

interface Group {
  start: number;
  end: number;
}

/**
 * IBAN recognizer. LOCATES a `CC##` head (2 letters, 2 digits) at a word boundary and
 * consumes alphanumeric groups separated by single spaces (electronic `DE89370400…` and
 * print `DE89 3704 0044 …` formats). Because prose can follow a print-format IBAN with a
 * space, candidates are tried longest-first, dropping trailing groups, until the
 * validator accepts one. `validator.isIBAN` (registry format + mod-97) DECIDES; the Go
 * mirror uses the identical locator with its own mod-97 + registry-length check.
 */
export const IBAN_RECOGNIZER: Recognizer = {
  id: 'IBAN',
  find(text: string): Span[] {
    const spans: Span[] = [];
    let i = 0;
    while (i < text.length) {
      const head =
        isLetterAt(text, i) && isLetterAt(text, i + 1) && isDigitAt(text, i + 2) && isDigitAt(text, i + 3);
      if (!head || isWordCharAt(text, i - 1)) {
        i++;
        continue;
      }
      // Consume groups: a maximal alnum run, then optionally one space followed by alnum.
      const groups: Group[] = [];
      let pos = i;
      let stripped = 0;
      for (;;) {
        const start = pos;
        while (isAlnumAt(text, pos)) pos++;
        if (pos === start) break;
        groups.push({ start, end: pos });
        stripped += pos - start;
        if (stripped >= MAX_LEN) break;
        if (charAt(text, pos) === ' ' && isAlnumAt(text, pos + 1)) {
          pos++;
          continue;
        }
        break;
      }
      let matched = false;
      let len = stripped;
      for (let e = groups.length - 1; e >= 0; e--) {
        const g = groups[e]!;
        if (e < groups.length - 1) len -= groups[e + 1]!.end - groups[e + 1]!.start;
        if (len < MIN_LEN) break;
        if (len > MAX_LEN || isWordCharAt(text, g.end)) continue;
        const candidate = text.slice(i, g.end);
        if (isIBAN(candidate)) {
          spans.push({ start: i, end: g.end });
          i = g.end;
          matched = true;
          break;
        }
      }
      if (!matched) i++;
    }
    return spans;
  }
};

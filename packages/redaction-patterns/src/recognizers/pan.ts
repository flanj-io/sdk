import { isDigitAt, isWordCharAt, charAt } from '../chars';
import { passesLuhn } from '../luhn';
import type { Recognizer, Span } from '../recognizer';

/** PAN length bounds (ISO/IEC 7812) and the most groups a printed PAN uses (4-4-4-4-3). */
const MIN_DIGITS = 13;
const MAX_DIGITS = 19;
const MAX_GROUPS = 5;

interface DigitGroup {
  start: number;
  end: number;
}

/** Maximal runs of ASCII digits. */
function digitGroups(s: string): DigitGroup[] {
  const groups: DigitGroup[] = [];
  let i = 0;
  while (i < s.length) {
    if (isDigitAt(s, i)) {
      const start = i;
      while (isDigitAt(s, i)) i++;
      groups.push({ start, end: i });
    } else {
      i++;
    }
  }
  return groups;
}

/** Two adjacent groups are joinable when exactly one space or dash separates them. */
function joinable(s: string, a: DigitGroup, b: DigitGroup): boolean {
  if (b.start !== a.end + 1) return false;
  const sep = charAt(s, a.end);
  return sep === ' ' || sep === '-';
}

/**
 * PAN recognizer. LOCATES candidates structurally — chains of digit groups joined by
 * single spaces/dashes (bare, 4-4-4-4, 4-6-5, 4-4-4-4-3, dashed …) — normalizes them to
 * digits, and lets the Luhn validator DECIDE. Detect on normalized digits, redact the
 * original span. Anchored: a chain glued to a letter/digit/underscore on either side is
 * not a candidate (so ids/hashes/UUIDs never fire and digit runs are never split).
 *
 * Within a chain every sub-chain of ≤ MAX_GROUPS groups is tried longest-first from each
 * start, left to right, so a PAN preceded or followed by other separated digit groups
 * ("ref 1234 4111 1111 1111 1111", "4111111111111111 1225") is still found — the classic
 * leftmost-greedy regex tests the wrong window and leaks the card.
 */
export const PAN_RECOGNIZER: Recognizer = {
  id: 'PAN',
  find(text: string): Span[] {
    const spans: Span[] = [];
    const groups = digitGroups(text);
    let i = 0;
    while (i < groups.length) {
      // Build the maximal chain starting at group i.
      let j = i;
      while (j + 1 < groups.length && joinable(text, groups[j]!, groups[j + 1]!)) j++;
      const chain = groups.slice(i, j + 1);

      let k = 0;
      while (k < chain.length) {
        let matched = false;
        // Left anchor: a sub-chain starting mid-chain is preceded by a separator (fine);
        // the chain's first group must not be glued to a word character.
        const leftOk = k > 0 || !isWordCharAt(text, chain[0]!.start - 1);
        if (leftOk) {
          const lastE = Math.min(chain.length - 1, k + MAX_GROUPS - 1);
          for (let e = lastE; e >= k; e--) {
            // Right anchor: a sub-chain ending mid-chain is followed by a separator.
            const rightOk = e < chain.length - 1 || !isWordCharAt(text, chain[e]!.end);
            if (!rightOk) continue;
            let digits = '';
            for (let g = k; g <= e; g++) digits += text.slice(chain[g]!.start, chain[g]!.end);
            if (digits.length < MIN_DIGITS) break; // shorter sub-chains only get shorter
            if (digits.length > MAX_DIGITS) continue;
            if (passesLuhn(digits)) {
              spans.push({ start: chain[k]!.start, end: chain[e]!.end });
              k = e + 1;
              matched = true;
              break;
            }
          }
        }
        if (!matched) k++;
      }
      i = j + 1;
    }
    return spans;
  }
};

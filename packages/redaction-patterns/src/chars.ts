/**
 * ASCII character classes used for recognizer ANCHORING (item 6 of the floor's owned
 * responsibilities). Candidates are anchored against "word" characters so a sensitive
 * run glued to letters/digits/underscore inside an identifier is not a candidate, and a
 * digit run is never split. Kept ASCII-only so the Go mirror (`internal/redact`) is
 * byte-identical. `i` may be out of range; that counts as a boundary.
 */
export function isDigitAt(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
}

export function isLetterAt(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  const c = s.charCodeAt(i);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

export function isAlnumAt(s: string, i: number): boolean {
  return isDigitAt(s, i) || isLetterAt(s, i);
}

/** `[A-Za-z0-9_]` — the anchoring class. Out of range => false (a boundary). */
export function isWordCharAt(s: string, i: number): boolean {
  if (i < 0 || i >= s.length) return false;
  return isAlnumAt(s, i) || s.charCodeAt(i) === 95;
}

export function charAt(s: string, i: number): string {
  return i >= 0 && i < s.length ? s.charAt(i) : '';
}

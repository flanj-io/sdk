import { TOKEN_CLOSE, TOKEN_OPEN, type PatternId } from './tokens';

/**
 * Captured properties of a redacted value — computed from the ORIGINAL scalar, at the
 * only moment it still exists, so downstream consumers (the drift detector) can validate
 * the DECIDABLE spec constraints of a redacted field (type, min/maxLength) instead of
 * skipping it. NON-REVERSIBLE by design: these are coarse schema-level facts; never add
 * anything that narrows the value (no prefixes/suffixes, no entropy, no samples).
 *
 * Every definition here is part of the cross-language contract (the Go collector
 * computes the identical record; the fixture battery asserts byte-identical output):
 *  - `length` counts UNICODE CODE POINTS of the original scalar text (JS `[...s]`,
 *    Go `utf8.RuneCountInString`) — NOT UTF-16 units, NOT bytes;
 *  - lower/upper/digit classes are ASCII (a-z / A-Z / 0-9);
 *  - control = code point <= 0x1F or == 0x7F; printable = 0x20-0x7E; extended = > 0x7F.
 */
export interface ValueProps {
  type: 'string' | 'number';
  /** Code points of the original scalar text (a number's literal). */
  length: number;
  /** Numbers only: the literal had no fraction/exponent. */
  integer?: boolean;
  containsLowerCase: boolean;
  containsUpperCase: boolean;
  containsDigits: boolean;
  containsASCIIControlChars: boolean;
  containsASCIIPrintableChars: boolean;
  containsASCIIExtendedChars: boolean;
}

/** One whole-value redaction: where, what fired, and the original's properties. */
export interface RedactedField {
  /** RFC 6901 JSON Pointer into the scanned value ('' = the root scalar itself). */
  path: string;
  pattern: PatternId;
  props: ValueProps;
}

/** Compute the props of an original scalar. `text` is the scalar's text (a number's literal). */
export function computeProps(text: string, kind: 'string' | 'number', integer?: boolean): ValueProps {
  const props: ValueProps = {
    type: kind,
    length: 0,
    containsLowerCase: false,
    containsUpperCase: false,
    containsDigits: false,
    containsASCIIControlChars: false,
    containsASCIIPrintableChars: false,
    containsASCIIExtendedChars: false
  };
  if (kind === 'number') props.integer = integer ?? true;
  for (const ch of text) {
    props.length++;
    const c = ch.codePointAt(0)!;
    if (c >= 0x61 && c <= 0x7a) props.containsLowerCase = true;
    else if (c >= 0x41 && c <= 0x5a) props.containsUpperCase = true;
    else if (c >= 0x30 && c <= 0x39) props.containsDigits = true;
    if (c <= 0x1f || c === 0x7f) props.containsASCIIControlChars = true;
    else if (c <= 0x7e) props.containsASCIIPrintableChars = true;
    else props.containsASCIIExtendedChars = true;
  }
  return props;
}

/** RFC 6901 segment escaping: `~` -> `~0`, `/` -> `~1`. */
export function escapePointerSegment(segment: string): string {
  if (!segment.includes('~') && !segment.includes('/')) return segment;
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Matches a scalar that is EXACTLY one emitted token; group 1 = the pattern id. */
export const WHOLE_TOKEN_RE = new RegExp(`^${TOKEN_OPEN}REDACTED:([A-Z0-9_]+)${TOKEN_CLOSE}$`);

/** The pattern id when `value` is exactly one token, else null. */
export function wholeTokenId(value: string): PatternId | null {
  const m = WHOLE_TOKEN_RE.exec(value);
  return m ? (m[1] as PatternId) : null;
}

/** Canonical field order: sorted by path (fields never share a path). */
export function sortFields(fields: RedactedField[]): RedactedField[] {
  return fields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

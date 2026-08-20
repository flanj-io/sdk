import type { PatternId } from './tokens';

/** A half-open [start, end) span inside a single scalar string. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Where a scalar sits in its enclosing structure. `key` is the (original, un-redacted)
 * object key whose value is being scanned; absent for keys, array elements, and free text.
 * Only contextual recognizers (CVV) use it.
 */
export interface ScanContext {
  key?: string;
}

/**
 * One pattern of the floor. `find` returns the CONFIRMED sensitive spans inside a single
 * scalar string — confirmed meaning a hardened validator (Luhn, mod-97, email grammar,
 * phone metadata) said yes; our code only LOCATES candidates, it never decides by regex.
 *
 * Contract for implementations (mirrored byte-for-byte by the Go collector):
 *  - spans are sorted by `start` and non-overlapping;
 *  - `find` is pure and must never perform I/O;
 *  - the engine behind a recognizer is swappable: replacing one recognizer (e.g. with a
 *    recognizer-host engine) must not touch traversal, token format, base64 or gating.
 */
export interface Recognizer {
  readonly id: PatternId;
  find(value: string, ctx: ScanContext): Span[];
}

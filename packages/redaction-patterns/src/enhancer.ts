import type { RedactValueResult } from './redactor';
import { REPORT_ORDER } from './report-order';
import { makeToken, REDACTED_TOKEN_RE, type PatternId } from './tokens';

/**
 * One spec-declared sensitive field. `path` is dot-separated; a segment may end with `[]`
 * to address every element of an array. `type` must be a floor pattern id — it names the
 * token emitted (`⟦REDACTED:<type>⟧`); unknown types are ignored.
 */
export interface SensitiveField {
  path: string;
  type: PatternId;
}

const KNOWN: ReadonlySet<string> = new Set(REPORT_ORDER);

interface Segment {
  key: string;
  arrays: number; // how many trailing `[]`
}

function parsePath(path: string): Segment[] | null {
  if (path.length === 0) return null;
  const segments: Segment[] = [];
  for (const raw of path.split('.')) {
    let key = raw;
    let arrays = 0;
    while (key.endsWith('[]')) {
      key = key.slice(0, -2);
      arrays++;
    }
    if (key.length === 0) return null;
    segments.push({ key, arrays });
  }
  return segments;
}

/** True when a scalar already carries any floor token — such scalars are immutable here. */
function carriesToken(value: unknown): boolean {
  return typeof value === 'string' && new RegExp(REDACTED_TOKEN_RE.source).test(value);
}

/**
 * The schema-aware enhancer: our own spec-driven layer ABOVE the floor. It is applied to
 * the floor's OUTPUT and may only ADD redaction, never subtract:
 *  - it only ever replaces a string/number leaf that carries NO token with a token;
 *  - a scalar the floor already touched is immutable (a poisoned spec cannot relabel a
 *    PAN as EMAIL, nor "un-redact" anything — there is no operation for it);
 *  - paths that do not resolve are ignored; containers are never replaced.
 * The never-subtract law — every floor token survives, unchanged, at its path — is
 * asserted by both language suites over every fixture × every spec.
 */
export function enhance(value: unknown, spec: readonly SensitiveField[]): RedactValueResult {
  const fired = new Set<PatternId>();
  let current = value;
  for (const field of spec) {
    if (!KNOWN.has(field.type)) continue;
    const segments = parsePath(field.path);
    if (!segments) continue;
    current = apply(current, segments, 0, field.type, fired);
  }
  // The enhancer emits no captured-value fields: it is spec-driven, so the spec already
  // knows the declared shape of every field it redacts (adding props here is a possible
  // later additive extension, not needed for drift).
  return { redacted: current, hits: REPORT_ORDER.filter((id) => fired.has(id)), fields: [] };
}

function applyArrays(value: unknown, depth: number, next: () => (v: unknown) => unknown): unknown {
  if (depth === 0) return next()(value);
  if (!Array.isArray(value)) return value;
  return value.map((v) => applyArrays(v, depth - 1, next));
}

function apply(value: unknown, segments: Segment[], idx: number, type: PatternId, fired: Set<PatternId>): unknown {
  const seg = segments[idx];
  if (seg === undefined) return value; // unreachable: callers stop at the leaf
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (!(seg.key in obj)) return value;
  const isLeaf = idx === segments.length - 1;
  const child = obj[seg.key];
  const replaced = applyArrays(child, seg.arrays, () =>
    isLeaf
      ? (v: unknown) => {
          if ((typeof v === 'string' || typeof v === 'number') && !carriesToken(v)) {
            fired.add(type);
            return makeToken(type);
          }
          return v;
        }
      : (v: unknown) => apply(v, segments, idx + 1, type, fired)
  );
  if (replaced === child) return value;
  return { ...obj, [seg.key]: replaced };
}

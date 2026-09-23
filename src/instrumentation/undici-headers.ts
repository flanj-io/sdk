type HeaderMap = Record<string, string | string[]>;

/**
 * Normalize every header shape undici accepts or produces into one
 * lowercase-keyed map, the shape the http path hands the assembler:
 *
 * - a plain object (`fetch()`'s own request headers; undici 7's parsed response headers),
 * - a FLAT array `[name, value, name, value, …]` of strings or Buffers (undici 6's raw
 *   response headers; a direct `dispatch()` caller's request headers),
 * - an iterable of `[name, value]` pairs (a `Headers` or `Map`).
 *
 * Values may be strings, numbers, Buffers or arrays of them. A repeated name
 * accumulates into an array. Never throws: an unrecognisable shape is `{}`.
 */
export function normalizeUndiciHeaders(headers: unknown): HeaderMap {
  const out: HeaderMap = {};
  try {
    if (headers === null || headers === undefined) return out;
    if (Array.isArray(headers)) {
      if (headers.length > 0 && Array.isArray(headers[0])) {
        for (const pair of headers as unknown[][]) add(out, pair[0], pair[1]);
      } else {
        for (let i = 0; i + 1 < headers.length; i += 2) add(out, headers[i], headers[i + 1]);
      }
      return out;
    }
    if (typeof headers !== 'object') return out;
    if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
      for (const pair of headers as Iterable<unknown>) {
        if (Array.isArray(pair)) add(out, pair[0], pair[1]);
      }
      return out;
    }
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) add(out, name, value);
  } catch {
    // A header shape we cannot read costs the headers, never the call.
  }
  return out;
}

function add(out: HeaderMap, rawName: unknown, rawValue: unknown): void {
  if (rawName === null || rawName === undefined || rawValue === null || rawValue === undefined) return;
  const name = text(rawName).toLowerCase();
  const values = Array.isArray(rawValue) ? rawValue.map(text) : [text(rawValue)];
  const existing = out[name];
  if (existing === undefined) out[name] = values.length === 1 ? (values[0] as string) : values;
  else out[name] = [...(Array.isArray(existing) ? existing : [existing]), ...values];
}

function text(v: unknown): string {
  // HTTP header bytes are latin1 on the wire, which is how undici decodes them too.
  return Buffer.isBuffer(v) ? v.toString('latin1') : String(v);
}

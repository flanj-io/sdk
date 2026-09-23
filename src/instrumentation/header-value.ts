/**
 * One header's value as a single string: a repeated header is joined with
 * `, ` (RFC 9110 §5.3), a number (`content-length` from `getHeader`) becomes its
 * decimal text, and an absent header stays `undefined`.
 */
export function headerValue(v: string | number | readonly string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

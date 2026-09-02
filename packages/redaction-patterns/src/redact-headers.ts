import { redact } from './redact';
import { makeToken } from './tokens';

/**
 * Default header allowlist (CONTRACTS §2). Every other header key is DROPPED —
 * not redacted, not emitted. Keys are matched case-insensitively.
 */
export const DEFAULT_HEADER_ALLOWLIST: readonly string[] = [
  'content-type',
  'content-length',
  'content-encoding',
  'x-request-id',
  'x-correlation-id',
  'idempotency-key',
  'user-agent',
  'date'
];

/**
 * Credential-bearing headers. If one is ever seen in an allowlisted context it
 * is emitted as a `⟦REDACTED:TOKEN⟧` token, never raw. They are NOT in the
 * default allowlist, so by default they are dropped entirely.
 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set(['authorization', 'cookie', 'set-cookie']);

type HeaderValue = string | string[] | number | undefined;

/**
 * Produce a redacted, allowlisted header map suitable for storage/emission.
 * - keys not in `allowlist` (case-insensitive) are dropped;
 * - credential headers are forced to a TOKEN token if allowlisted;
 * - surviving values are run through {@link redact} as defense-in-depth.
 */
export function redactHeaders(
  headers: Record<string, HeaderValue> | undefined,
  allowlist: readonly string[] = DEFAULT_HEADER_ALLOWLIST
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const allow = new Set(allowlist.map((k) => k.toLowerCase()));
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!allow.has(key)) continue;
    if (rawValue === undefined) continue;
    if (SENSITIVE_HEADERS.has(key)) {
      out[key] = makeToken('TOKEN');
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    out[key] = redact(value);
  }
  return out;
}

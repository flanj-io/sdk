import type { Recognizer, Span } from '../recognizer';

/**
 * Secret-key shaped credentials: `sk_live_…`, `sk_test_…`, `pk_live_…`, `rk_test_…` (two
 * lowercase letters, a live/test environment, ≥ 6 key chars).
 */
const SECRET_KEY = /\b[a-z]{2}_(?:live|test)_[A-Za-z0-9]{6,}/g;

/** Three base64url segments starting with `eyJ` (`{"`). The header is VALIDATED below. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

/** `Bearer <token>` (scheme is case-insensitive per RFC 7235); the token is group 1. */
const BEARER = /\bbearer\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/** Decode a base64url segment and require a JSON object — a real JOSE header. */
function isJoseHeader(segment: string): boolean {
  try {
    const buf = Buffer.from(segment, 'base64url');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Credential recognizer. Secrets have no checksum library; these are format-anchored
 * shapes (the JWT additionally validates that its header decodes to a JSON object).
 * Overlapping hits (e.g. `Bearer sk_live_…`) keep the longest span.
 */
export const TOKEN_RECOGNIZER: Recognizer = {
  id: 'TOKEN',
  find(text: string): Span[] {
    const found: Span[] = [];
    let m: RegExpExecArray | null;

    const sk = new RegExp(SECRET_KEY.source, 'g');
    while ((m = sk.exec(text)) !== null) found.push({ start: m.index, end: m.index + m[0].length });

    const jwt = new RegExp(JWT.source, 'g');
    while ((m = jwt.exec(text)) !== null) {
      const header = m[0].slice(0, m[0].indexOf('.'));
      if (isJoseHeader(header)) found.push({ start: m.index, end: m.index + m[0].length });
    }

    const bearer = new RegExp(BEARER.source, 'gi');
    while ((m = bearer.exec(text)) !== null) {
      const tok = m[1]!;
      const start = m.index + m[0].length - tok.length;
      found.push({ start, end: start + tok.length });
    }

    // Sort by start, longest first; drop anything overlapping an accepted span.
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const spans: Span[] = [];
    for (const s of found) {
      const last = spans[spans.length - 1];
      if (last && s.start < last.end) continue;
      spans.push(s);
    }
    return spans;
  }
};

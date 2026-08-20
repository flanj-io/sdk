import isIP from 'validator/lib/isIP';
import { isWordCharAt, charAt } from '../chars';
import type { Recognizer, Span } from '../recognizer';

/** Dotted quad shape; `validator.isIP(_, 4)` decides (rejects 256.1.1.1 etc.). */
const IPV4_CANDIDATE = /(?:\d{1,3}\.){3}\d{1,3}/g;
/** Hex groups with ≥ 2 colons (covers `::1`, `2001:db8::1`); `isIP(_, 6)` decides. */
const IPV6_CANDIDATE = /(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}/g;

function bounded(text: string, start: number, end: number, extra: string): boolean {
  const before = charAt(text, start - 1);
  const after = charAt(text, end);
  if (isWordCharAt(text, start - 1) || isWordCharAt(text, end)) return false;
  return !extra.includes(before || ' ') && !extra.includes(after || ' ');
}

/**
 * IP recognizer (OPTIONAL — off by default; enable with `includeIp`). IPs are identifiers
 * more often than PII and over-redact peer hosts, so the floor leaves them unless asked.
 */
export const IP_RECOGNIZER: Recognizer = {
  id: 'IP',
  find(text: string): Span[] {
    const spans: Span[] = [];
    let m: RegExpExecArray | null;
    const v4 = new RegExp(IPV4_CANDIDATE.source, 'g');
    while ((m = v4.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (bounded(text, start, end, '.') && isIP(m[0], 4)) spans.push({ start, end });
    }
    const v6 = new RegExp(IPV6_CANDIDATE.source, 'g');
    while ((m = v6.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length < 2) continue;
      if (bounded(text, start, end, ':.') && isIP(m[0], 6)) spans.push({ start, end });
    }
    spans.sort((a, b) => a.start - b.start);
    const out: Span[] = [];
    for (const s of spans) {
      const last = out[out.length - 1];
      if (last && s.start < last.end) continue;
      out.push(s);
    }
    return out;
  }
};

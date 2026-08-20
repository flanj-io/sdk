import isEmail from 'validator/lib/isEmail';
import type { Recognizer, Span } from '../recognizer';

/**
 * Email-shaped candidate: local part, `@`, dotted domain with an alphabetic TLD (≥ 2).
 * Shape only — `validator.isEmail` decides. The Go mirror uses the identical shape with
 * `govalidator.IsEmail`.
 */
const EMAIL_CANDIDATE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Characters the candidate shape allows at the start but an address cannot begin with. */
const LEADING_TRIM = new Set(['.', '_', '%', '+', '-']);

export const EMAIL_RECOGNIZER: Recognizer = {
  id: 'EMAIL',
  find(text: string): Span[] {
    const spans: Span[] = [];
    const re = new RegExp(EMAIL_CANDIDATE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let start = m.index;
      const end = m.index + m[0].length;
      while (start < end && LEADING_TRIM.has(text.charAt(start))) start++;
      const candidate = text.slice(start, end);
      if (candidate.length > 0 && isEmail(candidate)) {
        spans.push({ start, end });
      }
    }
    return spans;
  }
};

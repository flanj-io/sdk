import { isWordCharAt } from '../chars';
import type { Recognizer, Span } from '../recognizer';

/**
 * US SSN `###-##-####`. An SSN has no checksum, so this recognizer is FORMAT-anchored by
 * definition (the Go mirror confirms the same candidate with `govalidator.IsSSN`, which is
 * the same format rule). A bare 9-digit run is deliberately NOT a candidate — that is a
 * common id shape and would over-redact. Anchored against word characters on both sides
 * (a dash neighbour is allowed so `ssn-123-45-6789` is still caught).
 */
const SSN_CANDIDATE = /\d{3}-\d{2}-\d{4}/g;

export const SSN_RECOGNIZER: Recognizer = {
  id: 'SSN',
  find(text: string): Span[] {
    const spans: Span[] = [];
    const re = new RegExp(SSN_CANDIDATE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (isWordCharAt(text, start - 1) || isWordCharAt(text, end)) continue;
      spans.push({ start, end });
    }
    return spans;
  }
};

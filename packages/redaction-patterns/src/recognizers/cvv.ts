import { isDigitAt } from '../chars';
import type { Recognizer, ScanContext, Span } from '../recognizer';

/**
 * Keys whose value is a card verification code. Case-insensitive; optional `card_`/`card-`
 * prefix. (`cid` is deliberately excluded — it is overwhelmingly "client/customer id".)
 */
const CVV_KEY = /^(?:card[_-]?)?(?:cvv2?|cvc2?|csc|security[_-]?code)$/i;

/** `cvv=123`, `cvc: 456`, `"cvv": "789"` inside free text / form bodies / malformed JSON. */
const CVV_TEXT = /\b((?:card[_-]?)?(?:cvv2?|cvc2?|csc|security[_-]?code))("?\s*[:=]\s*"?)(\d{3,4})/gi;

/** True when `key` names a card verification code field. Shared with the JSON number path. */
export function isCvvKey(key: string | undefined): boolean {
  return key !== undefined && CVV_KEY.test(key);
}

/** True when `value` is exactly a 3–4 digit CVV shape. */
export function isCvvShape(value: string): boolean {
  if (value.length < 3 || value.length > 4) return false;
  for (let i = 0; i < value.length; i++) if (!isDigitAt(value, i)) return false;
  return true;
}

/**
 * CVV is CONTEXTUAL: a bare 3–4 digit number is never a CVV. Two modes:
 *  - key mode (structured traversal gave us the key): the whole value is redacted when the
 *    key is a CVV key and the value is a 3–4 digit shape;
 *  - text mode (no key): `cvv=123` / `cvc: 456` / `"cvv":"789"` forms, digits span only.
 */
export const CVV_RECOGNIZER: Recognizer = {
  id: 'CVV',
  find(text: string, ctx: ScanContext): Span[] {
    if (isCvvKey(ctx.key) && isCvvShape(text)) {
      return [{ start: 0, end: text.length }];
    }
    // Otherwise (no key, non-CVV key, or a non-shape value) scan for textual forms.
    const spans: Span[] = [];
    const re = new RegExp(CVV_TEXT.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const digits = m[3]!;
      const end = m.index + m[0].length;
      if (isDigitAt(text, end)) continue; // 5+ digits is not a CVV shape
      spans.push({ start: end - digits.length, end });
    }
    return spans;
  }
};

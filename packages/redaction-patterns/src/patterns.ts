import { passesLuhn } from './luhn';
import { makeToken, PatternId } from './tokens';

/**
 * A redaction pattern: an id, and an `apply` that returns the input with every
 * match replaced by the pattern's token (or the input unchanged if nothing
 * matched). Patterns are add-only and MUST be inert to already-emitted
 * `⟦REDACTED:…⟧` tokens (idempotency invariant).
 */
export interface Pattern {
  readonly id: PatternId;
  apply(text: string): string;
}

// --- PAN (Luhn-gated) --------------------------------------------------------
// A run of 13–19 digits, optionally separated by single spaces or dashes, not
// embedded in a larger alphanumeric/digit run. Luhn decides the actual redaction.
const PAN_CANDIDATE = /(?<![A-Za-z0-9_])\d(?:[ -]?\d){12,18}(?![0-9])/g;

const PAN: Pattern = {
  id: 'PAN',
  apply(text) {
    return text.replace(PAN_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
        return makeToken('PAN');
      }
      return match;
    });
  }
};

// --- EMAIL -------------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL: Pattern = {
  id: 'EMAIL',
  apply(text) {
    return text.replace(EMAIL_RE, makeToken('EMAIL'));
  }
};

// --- IBAN (ISO-13616) --------------------------------------------------------
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const IBAN: Pattern = {
  id: 'IBAN',
  apply(text) {
    return text.replace(IBAN_RE, makeToken('IBAN'));
  }
};

// --- SSN (US ###-##-####) ----------------------------------------------------
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN: Pattern = {
  id: 'SSN',
  apply(text) {
    return text.replace(SSN_RE, makeToken('SSN'));
  }
};

// --- PHONE (E.164 + common separated formats) --------------------------------
const PHONE_E164_RE = /\+\d{7,15}\b/g;
const PHONE_SEPARATED_RE = /(?<![\d.])\d{3}[-.\s]\d{3}[-.\s]\d{4}(?![\d])/g;
const PHONE: Pattern = {
  id: 'PHONE',
  apply(text) {
    return text.replace(PHONE_E164_RE, makeToken('PHONE')).replace(PHONE_SEPARATED_RE, makeToken('PHONE'));
  }
};

// --- CVV (contextual: value of a cvv/cvc/cvv2 key) ---------------------------
const CVV_JSON_QUOTED_RE = /("(?:cvv2?|cvc2?)"\s*:\s*")(\d{3,4})(")/gi;
const CVV_JSON_UNQUOTED_RE = /("(?:cvv2?|cvc2?)"\s*:\s*)(\d{3,4})\b/gi;
const CVV_LOOSE_RE = /\b(cvv2?|cvc2?)(\s*[:=]\s*)(\d{3,4})\b/gi;
const CVV: Pattern = {
  id: 'CVV',
  apply(text) {
    return text
      .replace(CVV_JSON_QUOTED_RE, (_m, k, _v, q) => `${k}${makeToken('CVV')}${q}`)
      .replace(CVV_JSON_UNQUOTED_RE, (_m, k) => `${k}${makeToken('CVV')}`)
      .replace(CVV_LOOSE_RE, (_m, k, sep) => `${k}${sep}${makeToken('CVV')}`);
  }
};

// --- TOKEN (secret keys, JWTs, bearer credentials) ---------------------------
const SK_PK_RE = /\b[sp]k_(?:live|test)_[A-Za-z0-9]+/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
const TOKEN: Pattern = {
  id: 'TOKEN',
  apply(text) {
    return text
      .replace(SK_PK_RE, makeToken('TOKEN'))
      .replace(JWT_RE, makeToken('TOKEN'))
      .replace(BEARER_RE, (_m, prefix) => `${prefix}${makeToken('TOKEN')}`);
  }
};

// --- IP (optional; IPv4 + compact IPv6) --------------------------------------
const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const IPV6_RE = /(?<![:\w])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}(?![:\w])/g;
const IP: Pattern = {
  id: 'IP',
  apply(text) {
    return text.replace(IPV4_RE, makeToken('IP')).replace(IPV6_RE, makeToken('IP'));
  }
};

/**
 * Application order — chosen so earlier patterns strip structure that would
 * otherwise confuse later ones (TOKEN/IBAN consume digit runs before PAN sees
 * them). Reporting order is separate (see report-order.ts).
 */
export const PATTERNS: readonly Pattern[] = [TOKEN, CVV, IBAN, PAN, EMAIL, SSN, PHONE, IP];

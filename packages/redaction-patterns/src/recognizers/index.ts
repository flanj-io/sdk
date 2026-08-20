import type { Recognizer } from '../recognizer';
import { TOKEN_RECOGNIZER } from './token';
import { CVV_RECOGNIZER } from './cvv';
import { IBAN_RECOGNIZER } from './iban';
import { PHONE_RECOGNIZER } from './phone';
import { PAN_RECOGNIZER } from './pan';
import { EMAIL_RECOGNIZER } from './email';
import { SSN_RECOGNIZER } from './ssn';
import { IP_RECOGNIZER } from './ip';

/**
 * The mandatory floor, in APPLICATION order. Earlier recognizers consume structure that
 * would otherwise confuse later ones:
 *  - TOKEN and IBAN take their digit runs before the PAN chain scan sees them;
 *  - PHONE runs before PAN: the phone locator is `+`-anchored so it can never eat a PAN,
 *    but the PAN chain scan CAN eat a phone's national part plus trailing digits when
 *    they happen to pass Luhn (`+1 415 555 2671 1225`), so phone must claim its span first.
 * Reporting order is separate (see ../report-order.ts). The Go collector applies the
 * identical order.
 */
export const DEFAULT_RECOGNIZERS: readonly Recognizer[] = [
  TOKEN_RECOGNIZER,
  CVV_RECOGNIZER,
  IBAN_RECOGNIZER,
  PHONE_RECOGNIZER,
  PAN_RECOGNIZER,
  EMAIL_RECOGNIZER,
  SSN_RECOGNIZER
];

/** The optional IP recognizer, appended last when `includeIp` is set. */
export const OPTIONAL_IP_RECOGNIZER: Recognizer = IP_RECOGNIZER;

export {
  TOKEN_RECOGNIZER,
  CVV_RECOGNIZER,
  IBAN_RECOGNIZER,
  PHONE_RECOGNIZER,
  PAN_RECOGNIZER,
  EMAIL_RECOGNIZER,
  SSN_RECOGNIZER,
  IP_RECOGNIZER
};

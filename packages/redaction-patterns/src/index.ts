// Text entry point (default floor) — what the SDK capture path and the control-plane DLP use.
export { redact, redactDetailed } from './redact';
export type { RedactResult, RedactValueResult, Redactor, RedactorOptions } from './redactor';

// The swappable interface: build a redactor, structural + text entry points.
export { createRedactor } from './redactor';
export type { Recognizer, ScanContext, Span } from './recognizer';

// Captured value properties (whole-value redactions; drift consumes these).
export { computeProps } from './props';
export type { RedactedField, ValueProps } from './props';
export {
  DEFAULT_RECOGNIZERS,
  TOKEN_RECOGNIZER,
  CVV_RECOGNIZER,
  IBAN_RECOGNIZER,
  PAN_RECOGNIZER,
  EMAIL_RECOGNIZER,
  SSN_RECOGNIZER,
  PHONE_RECOGNIZER,
  IP_RECOGNIZER
} from './recognizers/index';

// The schema-aware enhancer (ADD-only layer above the floor).
export { enhance } from './enhancer';
export type { SensitiveField } from './enhancer';

// Headers, tokens, Luhn.
export { redactHeaders, DEFAULT_HEADER_ALLOWLIST } from './redact-headers';
export { makeToken, TOKEN_OPEN, TOKEN_CLOSE, REDACTED_TOKEN_RE } from './tokens';
export type { PatternId } from './tokens';
export { REPORT_ORDER } from './report-order';
export { passesLuhn } from './luhn';

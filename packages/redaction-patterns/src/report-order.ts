import { PatternId } from './tokens';

/**
 * Canonical order in which fired pattern ids are reported in
 * `RedactResult.patterns` (and thence `vinifera.redaction.patterns`). Matches
 * the ordering asserted by the golden vectors (e.g. combined bodies report
 * `["PAN","EMAIL","CVV"]`). Independent of the application order in patterns.ts.
 */
export const REPORT_ORDER: readonly PatternId[] = ['PAN', 'EMAIL', 'IBAN', 'SSN', 'PHONE', 'CVV', 'TOKEN', 'IP'];

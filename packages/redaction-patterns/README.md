# @vinifera/redaction-patterns

The **Vinifera redaction floor** — PAN/PII/secret redaction applied **at source** before any HTTP body is
stored or transmitted. Apache-2.0. Zero external calls, by construction and by test.

It is built as **composed, hardened validators behind our own swappable interface**: our code locates
candidates, recurses arbitrary nested structures, decodes base64, anchors and tokenizes; vetted validators
(`validator` for Luhn/email/IBAN, `libphonenumber-js` for phone) make every redact decision. No regex is the
detector; no third-party engine owns the pipeline. The design is documented in
[`REDACTION.md`](../../REDACTION.md).

This package is one of **two conforming implementations** of the same contract — the Go collector
(`internal/redact`) is the other — and both are held to the same golden files, vendored here from the canonical
`e2e/contracts/v1`:

- [`contracts/redaction-vectors.json`](../../contracts/redaction-vectors.json) — scalar-level vectors;
- [`contracts/redaction-fixtures.json`](../../contracts/redaction-fixtures.json) — the structured,
  cross-language **parity** battery (nested/undocumented fields, arrays, PAN-as-number, base64, inbound bodies,
  truncated/malformed/form bodies, negatives, poisoned-spec enhancer cases).

**The fixture files, not this code, are the source of truth.** The `@vinifera/sdk` redacts with this package at
the call site; the control plane reuses it for reply-box DLP.

## Install

```bash
yarn add @vinifera/redaction-patterns
```

## Usage

```ts
import { redact, redactDetailed, createRedactor, enhance, redactHeaders } from '@vinifera/redaction-patterns';

// Text entry point — what captured bodies go through. Only fired scalars are rewritten;
// JSON formatting, key order and untouched literals are preserved byte-for-byte.
redact('card 4111 1111 1111 1111 on file');
// -> 'card ⟦REDACTED:PAN⟧ on file'

redactDetailed('{"charge":{"source":{"card_number":"4242 4242 4242 4242","last4":"4242"},"meta":{"backup":"5555-5555-5555-4444","order_id":"4111111111111112"}}}');
// -> { text: '{"charge":{"source":{"card_number":"⟦REDACTED:PAN⟧","last4":"4242"},"meta":{"backup":"⟦REDACTED:PAN⟧","order_id":"4111111111111112"}}}',
//      patterns: ['PAN'] }          // undocumented nested field caught; non-Luhn order_id and last4 survive

// Structural entry point — recurse an already-parsed value; returns a redacted clone + hits.
createRedactor().redact({ payload: 'eyJjYXJkIjoiNDExMTExMTExMTExMTExMSIsImFtb3VudCI6MTIwMH0=', cvv: 123 });
// -> { redacted: { payload: '⟦REDACTED:PAN⟧', cvv: '⟦REDACTED:CVV⟧' }, hits: ['PAN', 'CVV'] }   // base64 decode-then-scan

// Schema-aware enhancer — ADD-only above the floor.
enhance({ national_id: 'AB123456C', card: '⟦REDACTED:PAN⟧' }, [{ path: 'national_id', type: 'SSN' }]);
// -> { redacted: { national_id: '⟦REDACTED:SSN⟧', card: '⟦REDACTED:PAN⟧' }, hits: ['SSN'] }

redactHeaders({ authorization: 'Bearer sk_live_x', 'x-request-id': 'req_1', 'x-secret': 'nope' });
// -> { 'x-request-id': 'req_1' }   // authorization not in default allowlist -> dropped; x-secret dropped
```

### The swappable interface

```ts
interface Recognizer { readonly id: PatternId; find(value: string, ctx: { key?: string }): Span[] }
interface Redactor {
  redact(value: unknown): { redacted: unknown; hits: PatternId[]; fields: RedactedField[] };
  redactText(text: string): { text: string; patterns: PatternId[]; fields: RedactedField[] };
}
createRedactor({ recognizers?: Recognizer[]; includeIp?: boolean }): Redactor
```

`fields` records every **whole-value** redaction — the RFC 6901 path, the pattern, and the ORIGINAL value's
non-reversible properties (type, length in code points, character-class flags; see `src/props.ts`). Downstream,
drift detection uses them to validate the decidable spec constraints (type, min/maxLength) of redacted fields.
Span-in-text redactions, redacted keys, form pairs and non-JSON text emit no records.

A `Recognizer` returns the **confirmed** sensitive spans inside one scalar; the `Redactor` owns traversal, the
token format, base64 and idempotency. Engine choice is per recognizer: swap one without touching the rest.

## The floor (all fire by default)

| id | Matches | Decided by | Token |
|---|---|---|---|
| `PAN` | 13–19 digit runs (separators stripped) **passing Luhn**, anchored | `validator.isLuhnNumber` | `⟦REDACTED:PAN⟧` |
| `EMAIL` | email-shaped candidates | `validator.isEmail` | `⟦REDACTED:EMAIL⟧` |
| `IBAN` | ISO-13616, electronic or print format | `validator.isIBAN` (registry + mod-97) | `⟦REDACTED:IBAN⟧` |
| `SSN` | US SSN `###-##-####` (format; no checksum exists) | — | `⟦REDACTED:SSN⟧` |
| `PHONE` | international (`+` country code) numbers in common formats | `libphonenumber-js/max` | `⟦REDACTED:PHONE⟧` |
| `CVV` | 3–4 digits as the value of a `cvv`/`cvc`/`cvv2`/`csc`/`security_code` key (or `cvv=123` in text) | context | `⟦REDACTED:CVV⟧` |
| `TOKEN` | Bearer tokens, JWTs (header validated), `sk_`/`pk_`-style keys | format | `⟦REDACTED:TOKEN⟧` |
| `IP` *(optional)* | IPv4 / IPv6 (`includeIp: true`) | `validator.isIP` | `⟦REDACTED:IP⟧` |

Plus, owned by the wrapper: **deep traversal** (keys too; PAN-as-number; CVV-under-key), **base64
decode-then-scan** (whole encoded run → token), **normalization** (detect on digits, redact the original span;
finds a PAN next to other separated digit groups), **form-urlencoded** decode-then-scan, **truncated/malformed
JSON** handled as residue (every byte is scanned by some path).

Token delimiters are `U+27E6`/`U+27E7` (`⟦ ⟧`) — regex-stable, JSON/text-safe, and make emitted tokens inert
to re-scanning.

## Invariants (enforced by `test/`)

1. **Add-only.** Redaction only replaces sensitive spans; it never un-redacts. The schema-aware enhancer may add
   above this floor, never subtract (`never-subtract` law asserted over every fixture × every spec).
2. **Idempotent.** `redact(redact(x)) === redact(x)`; a `⟦REDACTED:…⟧` token is a fixed point — the
   collector's defense-in-depth pass never double-wraps the SDK's output.
3. **Luhn-gated, anchored PAN.** A 16-digit non-Luhn number (an order id) is left intact; a Luhn-valid run glued
   inside an identifier is not a candidate; a valid PAN in any format is redacted.
4. **Contextual CVV.** A bare 3–4 digit number is never redacted.
5. **Zero I/O.** Lint-banned (`no-restricted-imports` on every network/DNS/process/fs primitive) and
   sentinel-tested (`test/no-network.spec.ts`).
6. **Parity.** The Go collector produces identical results on the shared fixtures.

## Testing

```bash
yarn workspace @vinifera/redaction-patterns test
```

`test/vectors.spec.ts` and `test/fixtures.spec.ts` iterate **every** case in the vendored golden files (both
entry points, idempotency, enhancer, never-subtract); `test/recognizers.spec.ts` pins behaviour not covered by the
contract; `test/no-network.spec.ts` is the zero-external-calls sentinel. Do not change a wire behaviour here
without first changing the canonical contract in `e2e/contracts/v1` and re-vendoring.

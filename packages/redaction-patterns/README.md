# @vinifera/redaction-patterns

The **Vinifera redaction floor** — pattern-based PAN/PII/secret redaction, applied **at source** before any
HTTP body is stored or transmitted. Apache-2.0.

This package is one of three conforming implementations of the same contract; the **golden vector file**
[`contracts/redaction-vectors.json`](../../contracts/redaction-vectors.json) (vendored from the canonical
`e2e/contracts/v1`), **not this code**, is the source of truth. The `@vinifera/sdk` redacts with it at the
call site; the control plane reuses it for reply-box DLP; the collector's Go processor reimplements it.

## Install

```bash
yarn add @vinifera/redaction-patterns
```

## Usage

```ts
import { redact, redactDetailed, redactHeaders } from '@vinifera/redaction-patterns';

redact('card 4111 1111 1111 1111 on file');
// -> 'card ⟦REDACTED:PAN⟧ on file'

redactDetailed('{"pan":"4111111111111111","email":"a@b.com","cvv":"999"}');
// -> { text: '{"pan":"⟦REDACTED:PAN⟧","email":"⟦REDACTED:EMAIL⟧","cvv":"⟦REDACTED:CVV⟧"}',
//      patterns: ['PAN', 'EMAIL', 'CVV'] }

redactHeaders({ authorization: 'Bearer sk_live_x', 'x-request-id': 'req_1', 'x-secret': 'nope' });
// -> { 'x-request-id': 'req_1' }   // authorization not in default allowlist -> dropped; x-secret dropped
```

## The floor (all fire by default)

| id | Matches | Token |
|---|---|---|
| `PAN` | 13–19 digit runs (separators stripped) **passing Luhn** | `⟦REDACTED:PAN⟧` |
| `EMAIL` | RFC-ish email | `⟦REDACTED:EMAIL⟧` |
| `IBAN` | ISO-13616 IBAN | `⟦REDACTED:IBAN⟧` |
| `SSN` | US SSN `###-##-####` | `⟦REDACTED:SSN⟧` |
| `PHONE` | E.164 / common separated formats | `⟦REDACTED:PHONE⟧` |
| `CVV` | 3–4 digits in a `cvv`/`cvc`/`cvv2` **key context** only | `⟦REDACTED:CVV⟧` |
| `TOKEN` | Bearer tokens, JWTs, `sk_`/`pk_` secret keys | `⟦REDACTED:TOKEN⟧` |
| `IP` | IPv4 / IPv6 | `⟦REDACTED:IP⟧` |

Token delimiters are `U+27E6`/`U+27E7` (`⟦ ⟧`) — regex-stable, JSON/text-safe, and make emitted tokens inert
to re-scanning.

## Invariants (enforced by `test/vectors.spec.ts`)

1. **Add-only.** Redaction only replaces sensitive spans; it never un-redacts. Schema-aware redaction (a
   post-v0 enhancer) may add above this floor, never subtract.
2. **Idempotent.** `redact(redact(x)) === redact(x)`; a `⟦REDACTED:…⟧` token is a fixed point — the
   collector's defense-in-depth pass never double-wraps the SDK's output.
3. **Contextual CVV.** A bare 3–4 digit number is never redacted; only the value of a `cvv`/`cvc`/`cvv2` key is.
4. **Luhn-gated PAN.** A 16-digit non-Luhn number (an order id) is left intact; a valid PAN is redacted.

## Testing

```bash
yarn workspace @vinifera/redaction-patterns test
```

The suite iterates **every** case in the vendored vector file and additionally asserts the global idempotency
and add-only invariants. Do not change a wire behaviour here without first changing the canonical contract.

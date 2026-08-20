# Redaction — the floor, how it is built, and how it stays identical across languages

This document is the engineering reference for the Vinifera **redaction floor**: the mandatory PAN/PII/secret
redaction applied to **every captured body** — inbound and outbound, any edge classification — **at source,
before anything is stored or transmitted**. It is the highest-consequence code in the product.

The floor exists twice, in two languages, and must behave identically:

| Where | Language | Package | Role |
|---|---|---|---|
| SDK (this repo) | TypeScript | `@vinifera/redaction-patterns` | redacts at the call site, before export |
| Control plane | TypeScript | `@vinifera/redaction-patterns` (vendored tarball until published) | DLP on human free-text (reply box) |
| Collector | Go | `internal/redact` | defense-in-depth re-scan of every ingested body |

---

## 1. Strategy: composed hardened validators behind our own swappable interface

A library evaluation found that **no drop-in redaction engine qualifies** for the floor in either language
(Luhn-validated PAN across formats + deep structured recursion + base64 decode-then-scan + broad PII + zero
external calls). The ones that recurse are regex-only and over-redact; the ones that validate are string-only;
the ones with network paths are disqualified outright.

So the floor **borrows validators and owns the pipeline**:

- **We do not hand-roll regex for detection.** Our code only *locates candidates* structurally (digit-run
  chains, `+`-prefixed digit groups, `CC##…` tokens, email/IP shapes). Every *decision* to redact is made by a
  hardened validator.
- **We do not adopt a whole redaction engine.** Traversal, gating, decoding, anchoring and the token format are
  ours, so they are identical across languages and cannot be changed under us by a dependency.

### Validators composed

| Pattern | TypeScript | Go |
|---|---|---|
| `PAN` | `validator.isLuhnNumber` | pure Luhn (`luhn.go`) |
| `EMAIL` | `validator.isEmail` | `govalidator.IsEmail` |
| `IBAN` | `validator.isIBAN` (registry format + mod-97) | own mod-97 + registry length table (`iban.go`) — govalidator has no `IsIBAN` |
| `PHONE` | `libphonenumber-js/max` `isValidPhoneNumber` | `nyaruka/phonenumbers` `Parse` + `IsValidNumber` |
| `SSN` | format-anchored (`###-##-####`; no checksum exists) | same + `govalidator.IsSSN` |
| `CVV` | contextual (key-aware) | same |
| `TOKEN` | format-anchored secrets; JWT header validated as a JSON object | same |
| `IP` *(optional)* | `validator.isIP` | `govalidator.IsIPv4/IsIPv6` |

**Why the PAN gate is pure Luhn and not `isCreditCard`/`IsCreditCard`.** Both libraries' credit-card checks are
*brand-prefix-gated* on top of Luhn: they reject a Luhn-valid 19-digit Visa, a Mir card, and any card whose
BIN is missing from their (different, independently drifting) tables. That would under-redact against the
contract ("13–19 digit runs passing Luhn") and make cross-language parity depend on two BIN tables staying in
sync forever. Luhn is a fixed function; over-redaction of the rare Luhn-colliding identifier is the safe failure
direction. Brand identification, if ever wanted in hits, is an annotation — never the gate.

### The interface (one shape, both languages)

```ts
interface Recognizer { id: PatternId; find(value: string, ctx: { key?: string }): Span[] }  // confirmed spans in ONE scalar
interface Redactor {
  redact(value: unknown): { redacted: unknown; hits: PatternId[] };   // recurses arbitrary nested structures
  redactText(text: string): { text: string; patterns: PatternId[] };  // the production path for captured bodies
}
createRedactor({ recognizers?, includeIp? })
```

Go mirror: `redact.Recognizer { ID() string; Find(value string, ctx Context) []Span }`,
`(*Redactor).RedactValue(any) (any, []string)`, `(*Redactor).Redact(string) Result`.

Engine choice is **per recognizer** behind this interface: a later move to a recognizer-host engine replaces
individual `Recognizer`s and touches nothing else.

---

## 2. What the wrapper owns (and why)

1. **Deep traversal.** Objects/maps, arrays/slices, (Go) structs — every scalar is scanned, keys included,
   undocumented nested fields included. Numbers/bools/null are untouched, **except** a 13–19 digit integer that
   passes Luhn (a PAN sent as a bare number) and a 3–4 digit number under a CVV key, which become string tokens.
2. **Luhn gating.** A 13–19 digit run is never redacted unless it passes Luhn. The non-Luhn 16-digit
   `order_id` survives; a 4-digit `last4` and an integer `amount` are never touched.
3. **Base64 decode-then-scan.** Any run of ≥ 20 base64 chars (std or url alphabet, padded or not) that decodes
   to printable UTF-8 text is scanned with the recognizers; on a hit the **whole encoded run** becomes the token
   of the highest-precedence pattern found. Binary blobs, hashes and ordinary long words decode to non-text and
   are never scanned. Depth 1.
4. **Normalization.** Separators (`4-4-4-4`, `4-6-5` Amex, `4-4-4-4-3`, dashes) are stripped for detection;
   the **original span** is redacted. A PAN preceded or followed by other separated digit groups
   (`ref 1234 4111 1111 1111 1111`, `4111111111111111 1225`) is still found — the wrapper searches every
   sub-chain of ≤ 5 groups, longest first, where a leftmost-greedy regex tests the wrong window and leaks.
5. **Token format.** `⟦REDACTED:<TYPE>⟧` (U+27E6/U+27E7). Tokens are inert to re-scan (never double-wrapped),
   which gives idempotency and lets the collector re-apply the floor safely.
6. **Anchoring.** Candidates are anchored against `[A-Za-z0-9_]` on both sides: a Luhn-valid run glued inside an
   identifier (`TXN4111111111111111`, a UUID, a hex digest) is not a PAN candidate — the deliberate trade-off
   that keeps ids/hashes out of the floor (the schema-aware enhancer covers documented PAN fields). Phone goes
   through the phone library and requires a `+` country code; a loose phone regex is exactly what re-caught the
   Luhn-spared order id in the evaluation. **Application order** is TOKEN, CVV, IBAN, PHONE, PAN, EMAIL, SSN,
   (IP): PHONE precedes PAN because the `+`-anchored phone locator can never eat a PAN, but the PAN chain scan
   can eat a phone's national part plus trailing digits when they happen to pass Luhn.
7. **Fail-closed, zero I/O.** The floor never performs I/O. TS: an ESLint `no-restricted-imports` ban on every
   network/DNS/process/fs primitive in `packages/redaction-patterns/src/**`, plus a runtime **network sentinel
   test** that arms `http`/`https`/`net`/`dns`/`child_process`/`fetch` and runs the entire battery. Go: a source
   ban on `govalidator.IsExistingEmail`/`IsDialString`/`IsHost` (they link `net` for DNS; the functions the floor
   calls are pure) and on `net/http`/`os/exec`/`os`, plus a CI `go list -deps` audit. No `apiKey`-style hooks
   exist in the dependency set; `libphonenumber-js` and `phonenumbers` have no `net` in their trees at all.

### The text path (how a body string is redacted)

Bodies arrive as strings. Rather than parse → clone → re-serialize (which reorders keys / reformats numbers
differently in JS and Go and destroys formatting), the text path **scans the text and rewrites only the scalars
that fired, in place**:

- **JSON** (`{`/`[`): a tolerant scanner walks the text tracking nesting and the current key; every string
  literal is decoded, scanned (keys too; values with their key as context), and re-encoded **canonically** only
  if it changed; number literals are checked for PAN-as-number / CVV-under-key; anything the scanner does not
  understand — malformed or **truncated** bodies (the capture cap cuts JSON mid-token) — is scanned as plain-text
  residue. **Every byte of the body is scanned by some path.** Pretty-printing, key order and untouched literals
  are preserved byte-for-byte.
- **form-urlencoded** (`k=v&k=v`, no whitespace): each key/value is percent-decoded (`email=jane%40x.com` is
  seen as an address), scanned with the key as context (`cvv=123` is contextual), and re-encoded minimally only
  if it changed.
- **anything else** (XML, plain text, a URL path, a whole-body base64 blob): one scalar.

Because only fired scalars are rewritten, the TS and Go text paths emit **the same bytes** for the same input.

---

## 3. Cross-language parity: enforced, not assumed

Two fixture files, canonical in `e2e/contracts/v1/` and vendored here under `contracts/`, are the contract —
**not either implementation**:

| File | What it pins | Run by |
|---|---|---|
| `redaction-vectors.json` | scalar/recognizer-level golden vectors (text in → text out + fired patterns) | TS package suite, CP suite, Go suite |
| `redaction-fixtures.json` | the structured battery: many PAN formats, PANs in arrays / nested / undocumented fields / keys / as numbers, base64 (std, url-safe, whole-body, embedded), inbound request bodies (high PII density, batches, form-encoded), truncated and malformed bodies, the negatives that must survive, idempotency, and the poisoned-spec enhancer cases | TS package suite, CP suite, Go suite |

For every `json` case both suites assert **both entry points** — structural `redact(value)` and the text path
over the serialized body, parsed back — by **deep equality**, the parity oracle (serializer differences in key
order / number formatting can neither mask nor fake a redaction difference). `text` cases must match
**byte-for-byte**. Every case must be idempotent. The TS and Go suites run the identical file, so the same PAN
redacts identically in both, and a divergence fails CI in whichever repo drifted.

Known divergence *class* (pinned down by the fixtures, not eliminated): the email and IBAN validators are
different libraries, so exotic inputs (quoted local parts, a BBAN with a letter where a country's format says
digits) may be judged differently. The fixtures pin the real-world shapes; add a fixture before relying on any
new shape.

**Adding a case:** edit the canonical file in `e2e/contracts/v1/`, re-vendor to `sdk/contracts/`,
`collector/contracts/`, `control-plane/contracts/` (byte-identical), make all three suites green.

---

## 4. The schema-aware enhancer — ADD-only, never subtract

Above the floor sits our own spec-driven **enhancer** (`enhance(value, spec)` / Go `redact.Enhance`). It is
applied to the floor's **output** with a list of `{path, type}` fields a provider spec marks sensitive (`path`
dot-separated, `[]` = every array element; `type` a floor pattern id), and it may only **add** tokens:

- it only ever replaces a string/number leaf that carries **no** token;
- a scalar the floor already touched is **immutable** to it — a poisoned spec cannot relabel a PAN as EMAIL,
  and there is no operation by which it could un-redact anything;
- unresolvable paths are ignored; containers are never replaced; unknown types are ignored.

The **never-subtract law** — every floor token survives, unchanged, at its path — is asserted by both language
suites over the cross product of every fixture × every spec in the file (plus a hostile spec that points at every
floor-redacted field with the wrong type). The fixture file's `poisoned-spec-*` cases show a spec that omits the
PAN field, points at the wrong field, mislabels the card field, and names nonexistent paths: the floor's PAN
token is present in every output. Wiring the enhancer to a spec source (deriving `spec` from an OpenAPI document)
is layered work above the floor and does not change the law.

---

## 4b. Downstream: drift detection on redacted bodies

The floor runs **before** drift detection (privacy first), so the collector's drift processor only ever sees
redacted bodies — and a spec constraint can "fail" solely because a value became a token (a `pattern` the token
cannot match; `integer`→`string` after the PAN-as-number rewrite). The drift detector is token-aware: schema
errors whose offending scalar carries a `⟦REDACTED:…⟧` token are **skipped** — redacted means *unknown*, never
*violated*. The skip is scalar-only (container-level errors like required-missing still fire; the floor never
adds or removes keys) and one-directional (it cannot mask drift on values the floor did not touch).

Above the skip sits **captured value properties**: for every WHOLE-VALUE redaction (the scalar became exactly
one token) both floors emit a field record — the RFC 6901 path, the pattern, and non-reversible `props` of the
ORIGINAL value (`type`, `length` in Unicode code points, `integer` for numbers, and six character-class flags;
exact definitions in `src/props.ts` and the fixture notes). The SDK ships them as the optional
`vinifera.redaction.fields` attribute (CONTRACTS §2); the collector's defense-in-depth pass merges in records
for anything *it* catches. Drift then validates the **decidable** constraints of a redacted field against the
props — `type` and `minLength`/`maxLength` violations are real findings again, phrased in property terms —
while undecidable constraints (`pattern`/`format`/`enum`) and token values without a record keep skipping
(which also covers older SDKs in the compatibility window). Span-in-text redactions, redacted keys, form pairs
and non-JSON text emit no records: their host strings are corrupted by the token bytes, so no judgement is
safe. Property expectations are pinned per-case in the fixture battery (`fields`), asserted byte-identically by
both language suites on both entry points.

## 5. Invariants (all enforced by tests)

1. **Add-only** — redaction only replaces sensitive spans; it never un-redacts; the enhancer can only add.
2. **Idempotent** — `redact(redact(x)) == redact(x)`; a token is a fixed point.
3. **Redact before store/emit** — the SDK drops the raw buffer the moment the redacted string exists; no raw
   body is ever set as an attribute, stored or transmitted, even transiently.
4. **Zero external calls** — the floor is a pure function of its input (lint + sentinel + net audit).
5. **Parity** — the same body redacts identically in TS and Go (shared fixtures, deep-equal / byte-exact).

## 6. Reporting a redaction gap

A body that reaches storage or the wire with raw PAN/PII is a security issue. Report it privately per
[SECURITY.md](./SECURITY.md) — please include the (synthetic!) payload shape; never a real card number.

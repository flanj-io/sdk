# Security Policy

## Reporting a Vulnerability

We take the security of Vinifera seriously — this project sits in the path of real API traffic,
which routinely carries sensitive and regulated data, and its whole reason for being is to keep
that data from leaking.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately via one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the **Security** tab), or
- email **security@vinifera.io**.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- affected version(s) / commit,
- any suggested mitigation.

We will acknowledge your report within **3 business days** and aim to provide a
remediation timeline within **10 business days**. We ask that you give us a
reasonable window to release a fix before any public disclosure, and we're happy
to credit you in the advisory unless you prefer to remain anonymous.

## Redaction

The SDK captures request/response bodies, so redaction is the security property everything else
rests on. How it is designed is documented in [REDACTION.md](./REDACTION.md); the guarantees are:

- **Redaction at source.** Every captured body — inbound and outbound, regardless of edge
  classification — is run through the redaction floor (`@vinifera/redaction-patterns`) in your
  process, and the raw buffer is dropped the moment the redacted string exists. No raw body is
  ever set as an attribute, stored, or transmitted — not even transiently. Internal edges are
  metadata-only: their bodies are never read at all.
- **Local, zero external calls.** The floor is a pure function of its input. It never performs
  network, DNS, process or filesystem I/O; this is enforced by a lint ban on every such primitive
  in the floor's source and by a runtime network sentinel test that runs the entire redaction
  battery. Its dependencies (`validator`, `libphonenumber-js`) are offline validators with no
  network code paths and no opt-in "phone home" hooks.
- **Hardened, not hand-rolled.** Detection decisions are made by vetted validators (Luhn for
  PANs, mod-97 for IBANs, phone metadata for numbers, a strict email grammar); our code only
  locates candidates, recurses nested structures, decodes base64, and anchors matches.
- **Cross-language parity.** The collector re-applies the identical floor in Go as defense in
  depth. A shared fixture suite (`contracts/redaction-fixtures.json`) is run by both the
  TypeScript and Go test suites, so the same payload redacts identically in both.
- **Add-only, idempotent.** Tokens (`⟦REDACTED:<TYPE>⟧`) are never un-redacted and never
  double-wrapped; schema-aware redaction can only add above the floor, never subtract.

### Reporting a redaction gap

**Any path by which raw PAN/PII can reach storage or the wire unredacted is a security issue and
is in scope** — including a payload shape the floor does not recognise, an encoding it does not
decode, or a difference between the TypeScript and Go behaviour. Report it privately as above. A
minimal, **synthetic** payload that reproduces the gap is the most useful thing you can include
(use public test card numbers; never a real card number or real personal data).

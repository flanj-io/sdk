# Contributing to `@vinifera/sdk`

Thanks for your interest in contributing. This repository is licensed under **Apache-2.0**.

## Developer Certificate of Origin (DCO)

All contributions to this repository must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org/). This certifies that you wrote or
otherwise have the right to submit the code you are contributing.

Sign off every commit by adding a `Signed-off-by` trailer with your real name and email:

```
Signed-off-by: Jane Doe <jane@example.com>
```

The easiest way is `git commit -s`. PRs with unsigned commits will not be merged; CI enforces the DCO check.

## Ground rules

- Keep this package **pristinely Apache-2.0** — fintech legal teams inspect it. Do not add code under
  copyleft or source-available licenses, and do not depend on packages that are not Apache/MIT/BSD/ISC.
- **Redaction is the security bar.** Any change touching capture or redaction must keep the redaction
  golden-vector suite green (`contracts/redaction-vectors.json`) and must never let a raw body reach an
  attribute, the store, or the wire before redaction.
- Follow the contract in `contracts/` (vendored from the canonical source). Wire-format changes go through
  the contract first, not here.

## Workflow

1. Branch, write tests first (lead with redaction), implement, `yarn test`.
2. `git commit -s`, open a PR. CI runs lint + unit + redaction-vector + OTLP contract tests.

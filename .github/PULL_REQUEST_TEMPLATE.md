<!-- Thanks for contributing to Flanj! Please fill this out so we can review quickly. -->

## What & why

<!-- What does this change do, and why? Link any related issue: Closes #123 -->

## How was it tested?

<!-- Commands run, new/updated tests, manual verification. -->

## Checklist

- [ ] Commits are **signed off** for the DCO (`git commit -s`) — see `CONTRIBUTING.md`.
- [ ] Tests pass locally (`yarn test`) and lint is clean (`yarn lint`).
- [ ] If this touches **redaction/capture**, the redaction golden-vector suite still passes and no raw
      body can reach an attribute, the store, or the wire before redaction.
- [ ] If this changes a **cross-repo wire format**, the change went through `contracts/` first.
- [ ] Docs / `CLAUDE.md` updated if behavior or structure changed.

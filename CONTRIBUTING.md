# Contributing to the Flanj SDK

Thanks for your interest in contributing. This repository is licensed under Apache-2.0.

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

- Keep this package Apache-2.0 throughout; legal and compliance teams at regulated organizations inspect
  it. Do not add code under copyleft or source-available licenses, and do not depend on packages that are
  not Apache, MIT, BSD or ISC.
- **Redaction is the security bar.** Capture is out of band and redaction runs at the source, in the
  user's process. Any change touching capture or redaction must keep the redaction golden-vector suite
  green (`contracts/redaction-vectors.json`) and must never let a raw body reach an attribute, the store,
  or the wire before redaction.
- Follow the contract in `contracts/` (vendored from the canonical source). Wire-format changes go through
  the contract first, not here.

## Workflow

1. Branch, write tests first (lead with redaction), implement, `yarn test`.
2. `git commit -s`, open a PR. CI runs lint, unit, redaction-vector and OTLP contract tests.

## Releasing

A release is a **tag**, not a laptop. `.github/workflows/release.yml` builds from an empty `dist/`, runs
the gate and the stranger-install smoke, packs both packages, checks the tarballs against the tag, keeps a
copy of them as a workflow artifact, publishes, and then installs what it published from the public
registry and runs it. Nothing else in this repo publishes.

Both packages are released together under one version number. `@flanj/sdk` depends on
`@flanj/redaction-patterns`, and `yarn pack` rewrites that `workspace:^` dependency into a plain semver
range **at pack time** — so the SDK tarball is uninstallable by anyone until the floor is on the registry.
That is why the floor is published first, and why the release publishes the *Yarn-produced tarballs* with
`npm publish <tgz>`: the bytes that go out are the bytes the checks inspected.

### Cutting a release

1. **Bump the version in a PR.** Three files state it, and `yarn test` holds them together: `package.json`,
   `packages/redaction-patterns/package.json`, and `src/version.ts` (the last is what the OTLP logger scope
   and the startup line report, so a drift there stamps every captured record with a version that was never
   published). Review and merge it like any other change.

2. **Rehearse.** Actions → **release** → *Run workflow*, with `tag` set to the version you are about to cut
   and `dry_run` left ticked (it defaults to true). See *What the dry run proves* below.

3. **Tag a freshly fetched `origin/main`, and push the tag:**

   ```bash
   git fetch origin
   git tag -a v0.2.0 origin/main -m "v0.2.0"
   git push origin v0.2.0
   ```

   The `git fetch` is not a formality. GitHub reads a workflow **from the tag's own tree**, so a tag cut
   from a stale checkout runs that commit's workflows — or, if `release.yml` did not exist at that commit,
   runs nothing at all, silently, with no error anywhere to tell you.

4. **Confirm a run actually started**, before you walk away:

   ```bash
   gh run list --workflow release.yml --limit 3
   ```

   No run means the tag is on the wrong commit. Delete it (`git push origin :v0.2.0`), fetch, tag again.

5. **Watch it finish.** The last step installs `@flanj/sdk@<version>` from the public registry into an
   empty directory with an empty npm config, and starts it both documented ways — `node -r
   @flanj/sdk/register` and `NODE_OPTIONS="--require @flanj/sdk/register"` — asserting the startup line
   names the version that was just released.

### What the dry run proves

Everything except the two registry writes: a clean build, `yarn lint`, `yarn test`, the stranger-install
smoke (`scripts/smoke-pack.sh`), both tarballs packed and uploaded as an artifact you can download and
open, every check in `scripts/verify-release.cjs`, and a rehearsal of the exact `npm publish` command lines
under `--dry-run`.

What it does **not** prove: the OIDC exchange with the registry. `--dry-run` stops npm before the request,
so a trusted-publisher configuration that is missing or misspelled still looks green here and fails on the
real tag. It fails *before* anything is written, so the cost is a re-tag, not a bad release.

### One-time setup: trusted publishing

The release authenticates with **npm trusted publishing** (OIDC). There is no npm token in this repository
and none is needed: GitHub mints a short-lived identity token for the workflow run (`id-token: write` in
`release.yml`), npm verifies it against a configuration stored on the package, and provenance is attached
to the published artifact. Because it is not a token, it cannot be leaked in a log, does not expire, and is
not blocked by two-factor authentication on the publishing account.

It is configured **per package**, by a package owner, on npmjs.com — the package must already exist on the
registry, so this is a one-time step for each of the two packages and not something a first publish can do:

1. Sign in to npmjs.com as an owner of the package.
2. Go to the package's **Settings** page — `https://www.npmjs.com/package/@flanj/sdk/access`, and
   `https://www.npmjs.com/package/@flanj/redaction-patterns/access`.
3. In **Trusted Publisher**, under *Select your publisher*, choose **GitHub Actions**, and enter:

   | field | value |
   |---|---|
   | Organization or user | `flanj-io` |
   | Repository | `sdk` |
   | Workflow filename | `release.yml` |
   | Environment name | *(leave empty)* |

   If the form offers an **Allowed actions** choice, permit `npm publish`.
4. Save. npm does not validate the configuration when you save it — a typo surfaces on the next real
   publish, not here.

The workflow filename must match exactly, so renaming `release.yml` means editing both packages'
configurations. Publishing also needs npm CLI **11.5.1 or later**; the workflow upgrades to a pinned npm
major when the runner's bundled one is older, and refuses to continue below the floor rather than falling
through to an authentication error at the end.

If an `NPM_TOKEN` secret exists on the repository, the workflow uses it **only** as a fallback after a
trusted publish has already failed, and never prints it. Nothing requires it; the intended state is that it
does not exist.

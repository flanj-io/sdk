#!/usr/bin/env bash
# Pack this repo and install it into a throwaway app, exactly as a stranger would:
# no source tree, no workspace links, no registry. Then run the zero-code entry
# end to end and assert a record actually arrives.
#
# `yarn pack` rewrites the `workspace:*` dependency to a plain version, so the
# scratch app must be given the redaction-patterns tarball too — on the registry
# that dependency is satisfied by publishing @flanj/redaction-patterns FIRST.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$repo_root"
yarn build   # the workspace package has no prepack of its own
yarn workspace @flanj/redaction-patterns pack -o "$work/redaction-patterns.tgz"
yarn pack -o "$work/flanj-sdk.tgz"

mkdir -p "$work/app"
cd "$work/app"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error \
  "$work/redaction-patterns.tgz" "$work/flanj-sdk.tgz"

# The declarations must be there too — a consumer on TypeScript gets no types otherwise.
test -f node_modules/@flanj/sdk/dist/index.d.ts   || { echo "SMOKE FAIL: dist/index.d.ts missing"; exit 1; }
test -f node_modules/@flanj/sdk/dist/register.d.ts || { echo "SMOKE FAIL: dist/register.d.ts missing"; exit 1; }

cp "$repo_root/scripts/smoke-app.cjs" .
node smoke-app.cjs

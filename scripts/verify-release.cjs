#!/usr/bin/env node
// Everything that must be true of the two tarballs BEFORE either is pushed to
// the registry. An npm version is published once and can never be republished,
// so every one of these has to be a hard failure here rather than a surprise
// for whoever installs it.
//
//   node scripts/verify-release.cjs --tag v1.2.3 --floor floor.tgz --sdk sdk.tgz
//
// It reads the TARBALLS, not the working tree: the working tree is what you
// meant to ship, the tarball is what ships. The two have diverged before —
// `files` entries match by basename unless they are `./`-anchored, and an emit
// option that is turned off leaves stale output in `dist/` that is still
// packed. Checking the artifact is the only way to see either.
//
// Every failure is collected and printed together; a release blocked by three
// problems should show three, not one per re-run.
'use strict';

const { execFileSync } = require('node:child_process');
const { basename } = require('node:path');

const FLOOR = '@flanj/redaction-patterns';
const SDK = '@flanj/sdk';

/**
 * What each tarball must and must not contain.
 *
 * `required` is the consumer-visible surface: the runnable entrypoints the
 * `exports` map promises, the declarations a TypeScript consumer needs, and the
 * documents the licence and the redaction story live in. `rootAllowlist` is the
 * other half — an exact set, because the failure it catches is a file that
 * leaks IN (CLAUDE.md, a scratch note), which no "must contain" list can see.
 */
const PACKAGES = {
  floor: {
    name: FLOOR,
    required: ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE'],
    rootAllowlist: ['LICENSE', 'README.md', 'package.json']
  },
  sdk: {
    name: SDK,
    required: [
      'dist/index.js',
      'dist/register.js',
      'dist/index.d.ts',
      'dist/register.d.ts',
      'README.md',
      'REDACTION.md',
      'LICENSE'
    ],
    rootAllowlist: ['LICENSE', 'README.md', 'REDACTION.md', 'package.json']
  }
};

const failures = [];
function fail(message) {
  failures.push(message);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !key.startsWith('--') || value === undefined) {
      throw new Error(`usage: verify-release.cjs --tag vX.Y.Z --floor <tgz> --sdk <tgz> (got ${argv.join(' ')})`);
    }
    out[key.slice(2)] = value;
  }
  for (const key of ['tag', 'floor', 'sdk']) {
    if (!out[key]) throw new Error(`--${key} is required`);
  }
  return out;
}

/** Entry names inside an npm tarball, with the `package/` prefix stripped. */
function listEntries(tgz) {
  const raw = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entries = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.endsWith('/'));
  const stray = entries.filter((entry) => !entry.startsWith('package/'));
  if (stray.length > 0) {
    fail(`${tgz}: ${stray.length} entr(ies) are not under package/ — this is not an npm tarball: ${stray.slice(0, 3).join(', ')}`);
  }
  return entries.filter((entry) => entry.startsWith('package/')).map((entry) => entry.slice('package/'.length));
}

function readManifest(tgz) {
  const raw = execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  return JSON.parse(raw);
}

/** Every shipped byte, concatenated — enough to scan for things no file may contain. */
function readAllContent(tgz) {
  return execFileSync('tar', ['-xzOf', tgz], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function checkTarball(label, tgz, version) {
  const spec = PACKAGES[label];
  const entries = listEntries(tgz);
  const present = new Set(entries);

  for (const want of spec.required) {
    if (!present.has(want)) fail(`${spec.name}: the tarball is missing ${want}`);
  }

  // The four families that have shipped by accident before, or would ship the
  // moment a `files` entry lost its `./` anchor.
  const forbidden = [
    ['a compiled test', (e) => basename(e).includes('.spec.')],
    ['a source map', (e) => e.endsWith('.map')],
    // `.d.ts` is the published surface; any other `.ts` is source, which this
    // package deliberately does not ship (so a map could not resolve anyway).
    ['TypeScript source', (e) => e.endsWith('.ts') && !e.endsWith('.d.ts')],
    ['a repo-only directory', (e) => /^(src|test|contracts|scripts|\.github)\//.test(e)]
  ];
  for (const [what, matches] of forbidden) {
    const leaked = entries.filter(matches);
    if (leaked.length > 0) {
      fail(`${spec.name}: ${what} must not be published — ${leaked.slice(0, 5).join(', ')}${leaked.length > 5 ? ` (+${leaked.length - 5} more)` : ''}`);
    }
  }

  const rootFiles = entries.filter((entry) => !entry.includes('/')).sort();
  const unexpected = rootFiles.filter((entry) => !spec.rootAllowlist.includes(entry));
  if (unexpected.length > 0) {
    fail(`${spec.name}: unexpected file(s) at the tarball root: ${unexpected.join(', ')}`);
  }

  // Sources are not shipped, so a sourceMappingURL comment could only point at
  // a `../src/*.ts` the install does not have: Go to Definition lands nowhere
  // and `--enable-source-maps` prints frames for paths that do not exist.
  if (readAllContent(tgz).includes('sourceMappingURL')) {
    fail(`${spec.name}: a published file carries a sourceMappingURL comment`);
  }

  const manifest = readManifest(tgz);
  if (manifest.name !== spec.name) {
    fail(`${tgz}: the tarball declares name "${manifest.name}", expected "${spec.name}"`);
  }
  if (manifest.version !== version) {
    fail(`${spec.name}: the tarball is version ${manifest.version}, but the tag says ${version} — the tag and package.json must agree`);
  }
  return { entries, manifest };
}

function main(argv) {
  const args = parseArgs(argv);

  const match = /^v(\d+\.\d+\.\d+)$/.exec(args.tag);
  if (!match) {
    fail(`"${args.tag}" is not a vMAJOR.MINOR.PATCH tag`);
    report();
    return;
  }
  const version = match[1];
  console.log(`verifying the ${args.tag} release artifacts`);

  checkTarball('floor', args.floor, version);
  const { manifest: sdkManifest } = checkTarball('sdk', args.sdk, version);

  // The seam between the two tarballs, and the reason the floor is published
  // first. In the working tree the SDK depends on the floor by `workspace:^`,
  // which no registry can resolve; `yarn pack` rewrites it to a plain range at
  // PACK time. If that rewrite did not happen, `npm i @flanj/sdk` fails for
  // every consumer with an unresolvable protocol, and the version is already
  // burned.
  const declared = (sdkManifest.dependencies || {})[FLOOR];
  if (declared === undefined) {
    fail(`${SDK}: the tarball does not depend on ${FLOOR} at all`);
  } else if (/^workspace:/.test(declared)) {
    fail(`${SDK}: depends on ${FLOOR} as "${declared}" — the workspace protocol was not rewritten at pack time and no consumer can install this`);
  } else if (!/^[\^~]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(declared)) {
    fail(`${SDK}: depends on ${FLOOR} as "${declared}", which is not a plain semver range`);
  } else if (!declared.includes(version)) {
    fail(`${SDK}: depends on ${FLOOR}@"${declared}" but the floor being published is ${version} — the SDK would resolve a different floor than the one this release built and tested`);
  }

  // `src/version.ts` states the version a second time, and it is what the
  // startup line and the OTLP logger scope report. When it drifts, every
  // captured record is stamped with a version that was never published, and
  // nothing downstream can tell. Read it out of the tarball, not the worktree.
  const versionJs = execFileSync('tar', ['-xzOf', args.sdk, 'package/dist/version.js'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (!versionJs.includes(`"${version}"`) && !versionJs.includes(`'${version}'`)) {
    fail(`${SDK}: dist/version.js does not report ${version} — the record scope and the startup line would name a version that was never published`);
  }

  report();
}

function report() {
  if (failures.length === 0) {
    console.log('OK: both tarballs match the tag and ship exactly what a consumer needs');
    return;
  }
  for (const message of failures) console.error(`RELEASE CHECK FAILED: ${message}`);
  console.error(`${failures.length} check(s) failed — nothing may be published`);
  process.exitCode = 1;
}

// Run as a process, never imported: `failures` is module state, so a second
// call in the same process would inherit the first call's verdict. The exit
// code is the whole interface.
try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`RELEASE CHECK FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

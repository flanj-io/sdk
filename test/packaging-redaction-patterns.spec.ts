import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, delimiter, sep } from 'node:path';

/**
 * `@flanj/redaction-patterns` is published as its own package, so it needs the
 * same guard as the root — and it had none. Three faults were live in the
 * manifest when the launch publish came to run it:
 *
 *  - no `prepack`. `dist/` is gitignored, so `yarn npm publish` from a fresh
 *    clone (CI, or any machine that has not run the root `tsc -b`) would have
 *    shipped a package whose `main` pointed at nothing.
 *  - `files: ["dist", "README.md"]`, unanchored — the field matches by BASENAME
 *    unless a pattern starts with `./`, so those patterns claim any `dist` or
 *    `README.md` at any depth rather than the two at the package root.
 *  - `license: "Apache-2.0"` with no LICENSE file in the package directory, so
 *    the tarball would have carried a licence claim and no licence text.
 *
 * As with the root spec, this asserts the real packer's output, not intent —
 * and it runs the packer with the repo's own `node_modules/.bin` stripped from
 * PATH. That is not belt-and-braces: `typescript` lived only in the ROOT
 * devDependencies, so the first cut of the `prepack` hook died with
 * `command not found: tsc` in a real `yarn npm publish`, while this suite went
 * green because Vitest is itself launched by Yarn and had already put the root
 * `.bin` on PATH for every child it spawns.
 */

const packageRoot = resolve(__dirname, '..', 'packages', 'redaction-patterns');

let packed: string[];

/**
 * The environment a publish from a clean shell would give the packer.
 *
 * Yarn hands every script it runs a `BERRY_BIN_FOLDER` of shims for the
 * binaries the *invoking* workspace can see, and puts it first on PATH. Vitest
 * is launched by `yarn test` at the ROOT, whose devDependencies include
 * `typescript` — so a child spawned from a spec inherits a `tsc` shim that the
 * redaction-patterns workspace has no claim to. Dropping the folder (and any
 * `node_modules/.bin` from this repo) is what makes this suite able to see the
 * missing dependency at all.
 */
function cleanShellEnv(): NodeJS.ProcessEnv {
  const repoRoot = resolve(__dirname, '..');
  const binFolder = process.env.BERRY_BIN_FOLDER;
  const env = { ...process.env, FORCE_COLOR: '0' };
  delete env.BERRY_BIN_FOLDER;
  env.PATH = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry !== binFolder)
    .filter((entry) => !(entry.startsWith(repoRoot) && entry.endsWith(`node_modules${sep}.bin`)))
    .join(delimiter);
  return env;
}

/** Drop SGR colour codes and OSC 8 hyperlinks — Yarn emits both when it thinks it is on CI. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

beforeAll(() => {
  const output = execFileSync('yarn', ['pack', '--dry-run'], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanShellEnv()
  });
  packed = output
    .split('\n')
    .map((line) => stripAnsi(line).replace(/^\s*➤\s*YN\d+:\s*/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('Done in') && !line.includes('lifecycle script'));

  // Guard the PARSE, not just the contents: a listing left prefixed by an
  // uncleaned colour code would pass every "nothing under src/" assertion below.
  expect(packed, 'the pack listing did not parse').toContain('package.json');
  for (const entry of packed) {
    expect(entry, `unparsed pack line: ${JSON.stringify(entry)}`).toMatch(/^[\w./@+-]+$/);
  }
}, 300_000);

describe('yarn pack — the published @flanj/redaction-patterns tarball', () => {
  it('ships the runnable entrypoint and its declarations', () => {
    expect(packed).toContain('dist/index.js');
    expect(packed).toContain('dist/index.d.ts');
  });

  it('ships every file main/types point at', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      main: string;
      types: string;
    };
    for (const target of [manifest.main, manifest.types]) {
      expect(packed, `main/types point at ${target}, which is not in the tarball`).toContain(
        target.replace(/^\.\//, '')
      );
    }
  });

  it('ships the recognizers, not just the barrel', () => {
    expect(packed.filter((file) => file.startsWith('dist/recognizers/')).length).toBeGreaterThan(0);
  });

  it('ships no sources or tests', () => {
    for (const prefix of ['src/', 'test/']) {
      const leaked = packed.filter((file) => file.startsWith(prefix));
      expect(leaked, `${prefix} must not be published`).toEqual([]);
    }
    expect(packed.filter((file) => file.includes('.spec.'))).toEqual([]);
  });

  it('ships the licence it claims, and nothing else at the root', () => {
    const rootFiles = packed.filter((file) => !file.includes('/'));
    expect(rootFiles.sort()).toEqual(['LICENSE', 'README.md', 'package.json']);
  });

  it('builds on prepack, because dist/ is gitignored', () => {
    // The listing above can only prove the packer shipped a dist that already
    // existed on this machine. Deleting dist/ to prove the rebuild would race
    // the root spec's `tsc -b`, so assert the hook itself: without it a clean
    // checkout publishes an empty package, and nothing else in this suite
    // would notice.
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.prepack).toBe('yarn build');
  });
});

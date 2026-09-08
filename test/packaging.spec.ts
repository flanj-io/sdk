import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The tarball must contain runnable code.
 *
 * `package.json` declares `exports` pointing at `./dist`, `.gitignore` ignores
 * `dist/`, and there is no `.npmignore` — so without a `files` field plus a
 * `prepack` build, `yarn pack` shipped exactly ONE dist entry (`dist/index.js`,
 * force-included because it is `main`), no `dist/register.js`, no type
 * declarations, and the whole of `src/`, `test/` and `contracts/`. A stranger's
 * `npm i @flanj/sdk` then `require('@flanj/sdk/register')` threw MODULE_NOT_FOUND.
 *
 * This asserts the real packer's output, not the manifest's intent.
 */

const repoRoot = resolve(__dirname, '..');

let packed: string[];

/** Drop SGR colour codes and OSC 8 hyperlinks — Yarn emits both when it thinks it is on CI. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

beforeAll(() => {
  // `yarn pack --dry-run` runs `prepack` (the build) and lists what would ship.
  // FORCE_COLOR=0 asks Yarn for plain output; it colorizes under CI otherwise,
  // and `stripAnsi` is the belt to that braces.
  const output = execFileSync('yarn', ['pack', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' }
  });
  packed = output
    .split('\n')
    .map((line) => stripAnsi(line).replace(/^\s*➤\s*YN\d+:\s*/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('Done in') && !line.includes('lifecycle script'));

  // Guard the PARSE, not just the contents. A listing that failed to clean up
  // (Yarn colorized it, say) would leave every line prefixed — and then the
  // "nothing under src/" assertions below would pass on garbage.
  expect(packed, 'the pack listing did not parse').toContain('package.json');
  for (const entry of packed) {
    expect(entry, `unparsed pack line: ${JSON.stringify(entry)}`).toMatch(/^[\w./@+-]+$/);
  }
}, 300_000);

describe('yarn pack — the published tarball', () => {
  it('ships the runnable entrypoints', () => {
    expect(packed).toContain('dist/index.js');
    expect(packed).toContain('dist/register.js');
  });

  it('ships type declarations for both exports', () => {
    expect(packed).toContain('dist/index.d.ts');
    expect(packed).toContain('dist/register.d.ts');
  });

  it('ships every file the exports map points at', () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      main: string;
      types: string;
      exports: Record<string, Record<string, string>>;
    };
    const referenced = new Set<string>([manifest.main, manifest.types]);
    for (const entry of Object.values(manifest.exports)) {
      for (const target of Object.values(entry)) referenced.add(target);
    }
    for (const target of referenced) {
      expect(packed, `exports/main/types point at ${target}, which is not in the tarball`).toContain(
        target.replace(/^\.\//, '')
      );
    }
  });

  it('ships no sources, tests, contracts or CI config', () => {
    for (const prefix of ['src/', 'test/', 'contracts/', '.github/']) {
      const leaked = packed.filter((file) => file.startsWith(prefix));
      expect(leaked, `${prefix} must not be published`).toEqual([]);
    }
  });

  it('ships no compiled test files', () => {
    expect(packed.filter((file) => file.includes('.spec.'))).toEqual([]);
  });

  it('ships the docs a consumer needs and nothing else at the root', () => {
    const rootFiles = packed.filter((file) => !file.includes('/'));
    expect(rootFiles.sort()).toEqual(['LICENSE', 'README.md', 'REDACTION.md', 'package.json']);
  });
});

/**
 * `src/version.ts` hardcodes the version a second time. It is what the OTLP
 * logger scope and the register banner report, so when it drifts from
 * package.json every captured record is stamped with a version that was never
 * published — silently, since nothing else reads it. The 0.0.1 -> 0.1.0 launch
 * bump had to be made by hand in both files.
 */
describe('the version is stated once, in two places that must agree', () => {
  const repoManifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };

  it('matches SDK_VERSION in src/version.ts', async () => {
    const { SDK_VERSION, SDK_NAME } = (await import('../src/version')) as {
      SDK_VERSION: string;
      SDK_NAME: string;
    };
    expect(SDK_VERSION).toBe(repoManifest.version);
    expect(SDK_NAME).toBe('@flanj/sdk');
  });

  it('keeps the workspace dependency on the redaction floor resolvable', () => {
    // `yarn npm publish` rewrites `workspace:^` to a caret range over the
    // floor's own version. A mismatched major/minor there publishes an SDK
    // that cannot resolve its only first-party dependency.
    const root = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const floor = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/redaction-patterns/package.json'), 'utf8')
    ) as { version: string };
    expect(root.dependencies['@flanj/redaction-patterns']).toMatch(/^workspace:/);
    expect(floor.version).toBe(repoManifest.version);
  });
});

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

beforeAll(() => {
  // `yarn pack --dry-run` runs `prepack` (the build) and lists what would ship.
  const output = execFileSync('yarn', ['pack', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  packed = output
    .split('\n')
    .map((line) => line.replace(/^➤\s*YN\d+:\s*/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('Done in') && !line.includes('lifecycle script'));
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

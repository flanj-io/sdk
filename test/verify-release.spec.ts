import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';

/**
 * `scripts/verify-release.cjs` is the last thing that runs before two tarballs
 * are pushed to a registry that never takes a version back. A guard nobody has
 * watched fail is not a guard: every check below is exercised against a tarball
 * built to break exactly that one rule, and asserted on the MESSAGE, so a check
 * that goes red for an unrelated reason cannot pass for the wrong one.
 *
 * The fixtures are synthesised rather than packed, on purpose — `yarn pack`
 * cannot be talked into producing most of these, which is the point.
 */

const script = resolve(__dirname, '../scripts/verify-release.cjs');
const VERSION = '9.9.9';

let work: string;

/** Write `files` under a `package/` root and tar it up exactly as npm would. */
function makeTarball(name: string, files: Record<string, string>): string {
  const stage = join(work, `stage-${name}`);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(stage, 'package', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const tgz = join(work, `${name}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'package']);
  return tgz;
}

function floorFiles(overrides: Record<string, string> = {}, version = VERSION): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: '@flanj/redaction-patterns', version }),
    'dist/index.js': 'exports.redact = () => {};\n',
    'dist/index.d.ts': 'export declare function redact(): void;\n',
    'README.md': '# floor\n',
    LICENSE: 'Apache-2.0\n',
    ...overrides
  };
}

function sdkFiles(overrides: Record<string, string> = {}, version = VERSION, floorRange = `^${VERSION}`): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name: '@flanj/sdk',
      version,
      dependencies: { '@flanj/redaction-patterns': floorRange }
    }),
    'dist/index.js': 'exports.start = () => {};\n',
    'dist/register.js': 'require("./index");\n',
    'dist/index.d.ts': 'export declare function start(): void;\n',
    'dist/register.d.ts': 'export {};\n',
    'dist/version.js': `exports.SDK_VERSION = "${version}";\n`,
    'README.md': '# sdk\n',
    'REDACTION.md': '# redaction\n',
    LICENSE: 'Apache-2.0\n',
    ...overrides
  };
}

function verify(
  tag: string,
  floor: Record<string, string>,
  sdk: Record<string, string>,
  label: string
): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--tag',
      tag,
      '--floor',
      makeTarball(`floor-${label}`, floor),
      '--sdk',
      makeTarball(`sdk-${label}`, sdk)
    ],
    { encoding: 'utf8' }
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'flanj-verify-release-'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('verify-release: the artifacts a correct release produces', () => {
  it('passes a well-formed pair', () => {
    const { status, output } = verify(`v${VERSION}`, floorFiles(), sdkFiles(), 'good');
    expect(output).toContain('OK: both tarballs match the tag');
    expect(status, output).toBe(0);
  });
});

describe('verify-release: each check, seen red', () => {
  it('refuses a tag that is not vMAJOR.MINOR.PATCH', () => {
    const { status, output } = verify('release-9.9.9', floorFiles(), sdkFiles(), 'badtag');
    expect(output).toContain('is not a vMAJOR.MINOR.PATCH tag');
    expect(status).toBe(1);
  });

  it('refuses a tag that disagrees with the packed version', () => {
    // The mistake this catches: bumping package.json, then tagging the number
    // you meant instead of the number you bumped to.
    const { status, output } = verify('v9.9.8', floorFiles(), sdkFiles(), 'tagskew');
    expect(output).toContain('but the tag says 9.9.8');
    expect(output).toContain('@flanj/sdk');
    expect(output).toContain('@flanj/redaction-patterns');
    expect(status).toBe(1);
  });

  it('refuses an SDK tarball that still carries the workspace: protocol', () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles(),
      sdkFiles({}, VERSION, 'workspace:^'),
      'workspace'
    );
    expect(output).toContain('the workspace protocol was not rewritten at pack time');
    expect(status).toBe(1);
  });

  it('refuses an SDK whose floor range points at a different floor version', () => {
    const { status, output } = verify(`v${VERSION}`, floorFiles(), sdkFiles({}, VERSION, '^9.9.8'), 'floorskew');
    expect(output).toContain('but the floor being published is 9.9.9');
    expect(status).toBe(1);
  });

  it('refuses an SDK that does not depend on the floor at all', () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles(),
      sdkFiles({ 'package.json': JSON.stringify({ name: '@flanj/sdk', version: VERSION }) }),
      'nofloor'
    );
    expect(output).toContain('does not depend on @flanj/redaction-patterns at all');
    expect(status).toBe(1);
  });

  it('refuses a tarball carrying a compiled test', () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles(),
      sdkFiles({ 'dist/redactor.spec.js': 'describe("x", () => {});\n' }),
      'spec'
    );
    expect(output).toContain('a compiled test must not be published');
    expect(output).toContain('dist/redactor.spec.js');
    expect(status).toBe(1);
  });

  it('refuses a tarball carrying a source map', () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles({ 'dist/index.js.map': '{"version":3}\n' }),
      sdkFiles(),
      'map'
    );
    expect(output).toContain('a source map must not be published');
    expect(status).toBe(1);
  });

  it('refuses a file pointing at a source map it does not ship', () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles(),
      sdkFiles({ 'dist/index.js': 'exports.start = () => {};\n//# sourceMappingURL=index.js.map\n' }),
      'mappingurl'
    );
    expect(output).toContain('carries a sourceMappingURL comment');
    expect(status).toBe(1);
  });

  it('refuses a tarball carrying TypeScript source', () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles(),
      sdkFiles({ 'dist/index.ts': 'export const start = () => {};\n' }),
      'source'
    );
    expect(output).toContain('TypeScript source must not be published');
    expect(status).toBe(1);
  });

  it('refuses a tarball carrying a repo-only directory', () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles(),
      sdkFiles({ 'contracts/CONTRACTS.md': '# wire format\n' }),
      'repodir'
    );
    expect(output).toContain('a repo-only directory must not be published');
    expect(status).toBe(1);
  });

  it('refuses an unexpected file at the tarball root', () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles(),
      sdkFiles({ 'CLAUDE.md': '# internal notes\n' }),
      'rootleak'
    );
    expect(output).toContain('unexpected file(s) at the tarball root: CLAUDE.md');
    expect(status).toBe(1);
  });

  it('refuses a tarball missing a runnable entrypoint', () => {
    const files = sdkFiles();
    delete files['dist/register.js'];
    const { status, output } = verify(`v${VERSION}`, floorFiles(), files, 'noregister');
    expect(output).toContain('the tarball is missing dist/register.js');
    expect(status).toBe(1);
  });

  it('refuses a tarball missing type declarations', () => {
    const files = sdkFiles();
    delete files['dist/register.d.ts'];
    const { status, output } = verify(`v${VERSION}`, floorFiles(), files, 'nodts');
    expect(output).toContain('the tarball is missing dist/register.d.ts');
    expect(status).toBe(1);
  });

  it('refuses a tarball missing a document a consumer needs', () => {
    const files = sdkFiles();
    delete files['REDACTION.md'];
    const { status, output } = verify(`v${VERSION}`, floorFiles(), files, 'noredactiondoc');
    expect(output).toContain('the tarball is missing REDACTION.md');
    expect(status).toBe(1);
  });

  it("refuses an SDK whose dist/version.js reports a version that is not being published", () => {
    const { status, output } = verify(
      `v${VERSION}`,
      floorFiles(),
      sdkFiles({ 'dist/version.js': 'exports.SDK_VERSION = "9.9.8";\n' }),
      'versionjs'
    );
    expect(output).toContain('dist/version.js does not report 9.9.9');
    expect(status).toBe(1);
  });

  it('reports every failing check at once, not the first', () => {
    const { status, output } = verify(
      'v9.9.8',
      floorFiles(),
      sdkFiles({ 'dist/x.spec.js': '\n' }, VERSION, 'workspace:^'),
      'multi'
    );
    expect(output).toMatch(/\n?\d+ check\(s\) failed/);
    const count = Number(/(\d+) check\(s\) failed/.exec(output)?.[1]);
    expect(count).toBeGreaterThanOrEqual(3);
    expect(status).toBe(1);
  });
});

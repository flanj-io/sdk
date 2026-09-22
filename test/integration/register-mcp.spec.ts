import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  attributesOf,
  onExit,
  startReceiver,
  waitFor,
  type ChildResult,
  type OtlpReceiver
} from '../helpers/otlp-harness';

/**
 * The zero-code entry switches on MCP capture too.
 *
 * `node -r @flanj/sdk/register` used to start HTTP body capture and nothing
 * else, while the Python SDK's `import flanj.register` auto-instrumented every
 * MCP client session. An agent shop reaching for the documented zero-code entry
 * therefore got silence from the one capture path it cared about — and silence
 * here is indistinguishable from an agent that made no calls.
 *
 * These run REAL children under the BUILT `dist/register.js`, against a real
 * in-process OTLP receiver, in an ISOLATED node_modules tree: the MCP package is
 * an optional peer this repo does not install, so the "installed" case plants a
 * stand-in of its own rather than touching the repo's own tree (which would race
 * `src/mcp/auto-instrument.spec.ts`, whose whole point is that neither package
 * is installed here).
 */

const repoRoot = resolve(__dirname, '../..');
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc');
const fixtures = resolve(repoRoot, 'test/fixtures/mcp-auto');
/**
 * How long to give a child's records to reach the receiver. Generous on purpose:
 * the child exports through a 1s batch window plus the exit flush, and this suite
 * shares the machine with the other integration suite and a `tsc -b`. A tight
 * deadline here fails as "MCP was not instrumented", which is a lie.
 */
const EXPORT_DEADLINE_MS = 30_000;

let receiver: OtlpReceiver;

beforeAll(async () => {
  execFileSync(process.execPath, [tsc, '-b'], { cwd: repoRoot, stdio: 'pipe' });
  expect(existsSync(resolve(repoRoot, 'dist/register.js')), 'dist/register.js was not built').toBe(true);
  receiver = await startReceiver();
}, 120_000);

afterAll(async () => {
  await receiver.close();
});

describe('dist/register.js — with no MCP client package installed', () => {
  it('is a silent no-op: the line names only HTTP, and the app is untouched', async () => {
    // No `@modelcontextprotocol` anywhere on this tree — the import fails and is swallowed.
    const sandbox = makeSandbox({ withMcpPackage: false });
    try {
      const result = await run(sandbox, 'no-mcp-app.mjs');
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('ran');
      expect(result.stderr).toContain('capturing http/https bodies');
      expect(result.stderr, 'MCP must not be claimed when no client package is installed').not.toContain('MCP');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('dist/register.js — with an MCP client package installed', () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = makeSandbox({ withMcpPackage: true });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('auto-instruments the client and names MCP in the one startup line', async () => {
    const before = receiver.records.length;
    const result = await run(sandbox, 'app.mjs');

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('called');
    expect(result.stderr).toContain('capturing http/https bodies and MCP client calls');

    await waitFor(() => receiver.records.length - before >= 2, EXPORT_DEADLINE_MS);
    const records = receiver.records.slice(before).map(attributesOf);

    const call = records.find((r) => r['flanj.record.type'] === 'call');
    expect(call, `no MCP call record; got ${JSON.stringify(records.map((r) => r['flanj.record.type']))}`).toBeDefined();
    expect(call!['flanj.mcp.tool.name']).toBe('get_balance');
    expect(call!['flanj.peer.host']).toBe('mcp.acme.test');

    const snapshot = records.find((r) => r['flanj.record.type'] === 'contract_snapshot');
    expect(snapshot, 'the observed tools/list must arrive as a contract snapshot').toBeDefined();
  }, 60_000);

  it('instruments a CommonJS app too — the other half of the dual package', async () => {
    const before = receiver.records.length;
    const result = await run(sandbox, 'app.cjs');

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('called');

    await waitFor(() => receiver.records.length - before >= 2, EXPORT_DEADLINE_MS);
    const call = receiver.records
      .slice(before)
      .map(attributesOf)
      .find((r) => r['flanj.record.type'] === 'call');
    expect(call, 'a CommonJS app reaches the require half of the package; it must be patched too').toBeDefined();
    expect(call!['flanj.mcp.tool.name']).toBe('get_balance');
  }, 60_000);

  it('FLANJ_QUIET=1 silences the line without silencing capture', async () => {
    const before = receiver.records.length;
    const result = await run(sandbox, 'app.mjs', { FLANJ_QUIET: '1' });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    await waitFor(() => receiver.records.length - before >= 2, EXPORT_DEADLINE_MS);
    expect(receiver.records.length - before).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

/**
 * An ESM application, and nothing between its first line and its first MCP call.
 *
 * The ESM half used to be patched by an `import()` the preload started and never
 * waited for. Whether that settled before the application's first line was a
 * race: on Node 24 the entry point always won it, and an ESM agent was captured
 * by nothing; on Node 23 and 22.12 it lost a few runs in ten under load, which
 * is how this suite used to see one record where it waited for two. Both calls
 * below start before the application awaits anything, so anything short of a
 * synchronous patch in the preload fails here.
 */
describe('dist/register.js — an ESM application calling MCP on its first line', () => {
  const UNPATCHED = /\[flanj\] MCP auto-instrumentation of the ESM build of @modelcontextprotocol\/sdk\/client\/index\.js failed/g;

  it('is captured from its first call, both calls, with no warning', async () => {
    const sandbox = makeSandbox({ withMcpPackage: true });
    try {
      const before = receiver.records.length;
      const result = await run(sandbox, 'first-line-app.mjs');

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('called');
      expect(result.stderr).not.toMatch(UNPATCHED);

      await waitFor(() => receiver.records.length - before >= 2, EXPORT_DEADLINE_MS);
      const types = receiver.records
        .slice(before)
        .map(attributesOf)
        .map((r) => r['flanj.record.type'])
        .sort();
      expect(types, 'the first-line tools/list AND tools/call must both be captured').toEqual([
        'call',
        'contract_snapshot'
      ]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it('says so, once, when the ESM client cannot be patched — and the app is untouched', async () => {
    // The CommonJS half patches fine; the ESM half the application holds does not.
    const sandbox = makeSandbox({ withMcpPackage: true, esmBuild: 'frozen-mcp-client.mjs' });
    try {
      const result = await run(sandbox, 'first-line-app.mjs');

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim(), 'a capture failure must never break the application').toBe('called');
      const warnings = result.stderr.match(UNPATCHED) ?? [];
      expect(warnings, `stderr was: ${result.stderr}`).toHaveLength(1);
      expect(result.stderr).toContain('FLANJ_SILENCE_CAPTURE_WARNINGS=1');

      const silenced = await run(sandbox, 'first-line-app.mjs', { FLANJ_SILENCE_CAPTURE_WARNINGS: '1' });
      expect(silenced.code, silenced.stderr).toBe(0);
      expect(silenced.stderr).not.toMatch(UNPATCHED);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * An isolated tree the child can resolve from: the built `dist` beside a
 * `node_modules` that symlinks the repo's real packages and — when asked —
 * carries the MCP stand-in. `dist/mcp/auto-instrument.js` and the app then both
 * resolve `@modelcontextprotocol/sdk` to the SAME file, which is what makes the
 * prototype patch reach the app's own class.
 */
function makeSandbox({
  withMcpPackage,
  esmBuild = 'fake-mcp-client.mjs'
}: {
  withMcpPackage: boolean;
  /** The fixture planted as the package's ESM half. */
  esmBuild?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'flanj-register-mcp-'));
  cpSync(resolve(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });

  const modules = join(root, 'node_modules');
  mkdirSync(modules);
  for (const entry of readdirSync(resolve(repoRoot, 'node_modules'))) {
    if (entry === '@modelcontextprotocol') continue;
    symlinkSync(resolve(repoRoot, 'node_modules', entry), join(modules, entry), 'junction');
  }

  if (withMcpPackage) {
    // DUAL, like the real package: an `import` condition and a `require` condition
    // pointing at two separate builds — therefore two separate `Client` class
    // objects. Which one the application holds depends on how the application
    // was written, so the entry has to patch both.
    const pkg = join(modules, '@modelcontextprotocol', 'sdk');
    mkdirSync(join(pkg, 'esm', 'client'), { recursive: true });
    mkdirSync(join(pkg, 'cjs', 'client'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@modelcontextprotocol/sdk',
        version: '1.30.0',
        type: 'module',
        exports: {
          './*': { import: './esm/*', require: './cjs/*' }
        }
      })
    );
    writeFileSync(join(pkg, 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }));
    cpSync(join(fixtures, esmBuild), join(pkg, 'esm', 'client', 'index.js'));
    cpSync(join(fixtures, 'fake-mcp-client.cjs'), join(pkg, 'cjs', 'client', 'index.js'));
    cpSync(join(fixtures, 'app.mjs'), join(root, 'app.mjs'));
    cpSync(join(fixtures, 'app.cjs'), join(root, 'app.cjs'));
    cpSync(join(fixtures, 'first-line-app.mjs'), join(root, 'first-line-app.mjs'));
  } else {
    writeFileSync(join(root, 'no-mcp-app.mjs'), "console.log('ran');\n");
  }
  return root;
}

function run(sandbox: string, entry: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ChildResult> {
  const child = spawn(process.execPath, ['-r', join(sandbox, 'dist/register.js'), join(sandbox, entry)], {
    cwd: sandbox,
    env: {
      ...process.env,
      OTEL_SERVICE_NAME: 'acme-agent',
      FLANJ_OTLP_ENDPOINT: receiver.base,
      FLANJ_QUIET: '',
      FLANJ_SILENCE_CAPTURE_WARNINGS: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return onExit(child);
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  attributesOf,
  childEnv,
  onExit,
  startProvider,
  startReceiver,
  waitFor,
  type OtlpReceiver,
  type Provider
} from '../helpers/otlp-harness';

/**
 * ESM named imports of `node:http` must be captured even when the importing
 * module evaluated BEFORE the SDK started.
 *
 * `enable()` patches the live CJS exports object (`process.getBuiltinModule`).
 * That reaches every caller that resolves the property at call time —
 * `http.request(...)`, `require('http').request` — but an ESM
 * `import { request } from 'node:http'` is a live binding into node:http's ESM
 * facade, a slot Node fills from the CJS exports when the facade is created and
 * never touches again on its own. A module that took that binding before
 * `start()` kept calling the ORIGINAL function: zero rows, no warning, while a
 * `require`-style caller beside it showed up normally. The fix re-syncs the
 * facade (`module.syncBuiltinESMExports()`) after every wrap and unwrap.
 *
 * These run REAL children under the BUILT `dist/register.js`: vitest's own
 * module transform turns a named import into a property lookup and cannot
 * reproduce the miss in-process.
 */

const repoRoot = resolve(__dirname, '../..');
const registerEntry = resolve(repoRoot, 'dist/register.js');
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc');
const fixtures = resolve(repoRoot, 'test/fixtures/esm-named-import');

let receiver: OtlpReceiver;
let provider: Provider;

beforeAll(async () => {
  // The children run the BUILT entry, so build it (`tsc -b` is a no-op when current).
  execFileSync(process.execPath, [tsc, '-b'], { cwd: repoRoot, stdio: 'pipe' });
  expect(existsSync(registerEntry), `${registerEntry} was not built`).toBe(true);

  receiver = await startReceiver();
  provider = await startProvider();
}, 120_000);

afterAll(async () => {
  await receiver.close();
  await provider.close();
});

/**
 * Run one child to completion, wait for `expected` new records (or the wait's
 * timeout — the caller's assertions then say what is missing), and return the
 * new records' attributes.
 */
async function runChild(args: string[], expected: number): Promise<Record<string, unknown>[]> {
  const before = receiver.records.length;
  const child = spawn(process.execPath, args, {
    env: childEnv(receiver, provider.url),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = await onExit(child);

  expect(result.stderr).toBe('');
  expect(result.code, 'the child must exit cleanly').toBe(0);
  expect(result.stdout.trim()).toBe('called');

  await waitFor(() => receiver.records.length - before >= expected);
  return receiver.records.slice(before).map(attributesOf);
}

const clientRows = (rows: Record<string, unknown>[], method: string, target: string) =>
  rows.filter(
    (a) => a['flanj.direction'] === 'client' && a['flanj.http.method'] === method && a['flanj.http.target'] === target
  );
const serverRows = (rows: Record<string, unknown>[]) => rows.filter((a) => a['flanj.direction'] === 'server');

describe('late start — the app module took { request, get, createServer } BEFORE the SDK', () => {
  let calls: Record<string, unknown>[];

  beforeAll(async () => {
    calls = await runChild([resolve(fixtures, 'late-start.mjs')], 4);
  }, 30_000);

  it('captures the POST made through the named `request` binding', () => {
    expect(clientRows(calls, 'POST', '/v1/charges')).toHaveLength(1);
  });

  it('captures the GET made through the named `get` binding', () => {
    expect(clientRows(calls, 'GET', '/v1/charges')).toHaveLength(1);
  });

  it('captures the ingress hit on the named `createServer` (a prototype patch — never affected)', () => {
    const rows = serverRows(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['flanj.http.target']).toBe('/echo');
  });

  it('emits exactly one record per call — the facade re-sync neither drops nor doubles', () => {
    expect(clientRows(calls, 'GET', '/echo')).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });
});

describe('preload — `node --import <register>` (the documented zero-code line)', () => {
  it('captures every call from an app that never imports the SDK itself', async () => {
    const calls = await runChild(['--import', pathToFileURL(registerEntry).href, resolve(fixtures, 'entry.mjs')], 4);

    expect(clientRows(calls, 'POST', '/v1/charges')).toHaveLength(1);
    expect(clientRows(calls, 'GET', '/v1/charges')).toHaveLength(1);
    expect(serverRows(calls)).toHaveLength(1);
    expect(calls).toHaveLength(4);
  }, 30_000);
});

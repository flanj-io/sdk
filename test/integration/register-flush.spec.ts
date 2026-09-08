import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attributesOf,
  childEnv,
  exitSignalOf,
  onExit,
  startProvider,
  startReceiver,
  waitFor,
  type ChildResult,
  type OtlpReceiver,
  type Provider
} from '../helpers/otlp-harness';

/**
 * The zero-code entry must not lose the last records.
 *
 * `src/register.ts` used to call `start()` and throw the handle away — and the
 * handle is the only flush/shutdown path. `BatchLogRecordProcessor` schedules
 * its export on a 1s **unref'd** timer, so any process that ends inside that
 * window (a one-shot script; a pod's last batch on SIGTERM) shipped nothing:
 * zero rows, exit 0. These tests run REAL children under the BUILT
 * `dist/register.js` against a real in-process OTLP receiver.
 */

const repoRoot = resolve(__dirname, '../..');
const registerEntry = resolve(repoRoot, 'dist/register.js');
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc');

let receiver: OtlpReceiver;
let provider: Provider;

beforeAll(async () => {
  // The children run the BUILT entry, so build it. `tsc -b` is incremental —
  // a no-op when the tree is already current.
  execFileSync(process.execPath, [tsc, '-b'], { cwd: repoRoot, stdio: 'pipe' });
  expect(existsSync(registerEntry), `${registerEntry} was not built`).toBe(true);

  receiver = await startReceiver();
  provider = await startProvider();
}, 120_000);

afterAll(async () => {
  await receiver.close();
  await provider.close();
});

describe('dist/register.js — the zero-code entry delivers the last batch', () => {
  it('a one-shot child that exits 0 still ships exactly one record', async () => {
    const before = receiver.records.length;

    const result = await run(['-r', registerEntry, resolve(repoRoot, 'test/fixtures/one-shot-call.js')]);

    expect(result.stderr).toBe('');
    expect(result.code, 'the child must exit cleanly').toBe(0);
    expect(result.stdout.trim()).toBe('called');

    await waitFor(() => receiver.records.length > before);
    expect(receiver.records.length - before).toBe(1);
  }, 30_000);

  it('a SIGTERMed child ships its in-flight batch and dies of the signal', async () => {
    const before = receiver.records.length;

    const child = spawn(
      process.execPath,
      ['-r', registerEntry, resolve(repoRoot, 'test/fixtures/long-running-call.js')],
      { env: childEnv(receiver, provider.url), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    const exited = onExit(child);

    // Kill as soon as the call has completed — well inside the 1s batch window,
    // so only the signal handler's flush can deliver the record.
    await waitFor(() => stdout.includes('called'));
    expect(stdout).toContain('called');
    child.kill('SIGTERM');

    const result = await exited;
    // Re-raised, not swallowed: the status stays the signal's, never a fabricated 0.
    expect(result.signal ?? exitSignalOf(result.code)).toBe('SIGTERM');

    await waitFor(() => receiver.records.length > before);
    expect(receiver.records.length - before).toBe(1);
  }, 30_000);

  it('the delivered record is the flanj.* call convention, not an empty envelope', async () => {
    const record = receiver.records[receiver.records.length - 1];
    const attributes = attributesOf(record);
    expect(attributes['flanj.record.type']).toBe('call');
    expect(attributes['flanj.integration']).toBe('acme-payments');
    expect(attributes['flanj.http.method']).toBe('POST');
  });
});

function run(args: string[]): Promise<ChildResult> {
  const child = spawn(process.execPath, args, {
    env: childEnv(receiver, provider.url),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return onExit(child);
}

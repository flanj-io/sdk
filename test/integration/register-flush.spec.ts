import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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

interface OtlpReceiver {
  base: string;
  /** Every `flanj.*` log record POSTed to /v1/logs, flattened. */
  records: Record<string, unknown>[];
  close: () => Promise<void>;
}

async function startReceiver(): Promise<OtlpReceiver> {
  const records: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/logs') {
        for (const record of parseLogRecords(Buffer.concat(chunks).toString('utf8'))) {
          records.push(record);
        }
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    records,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

/** Pull the log records out of one OTLP/HTTP JSON export body. */
function parseLogRecords(body: string): Record<string, unknown>[] {
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const resourceLog of payload?.resourceLogs ?? []) {
    for (const scopeLog of resourceLog?.scopeLogs ?? []) {
      for (const record of scopeLog?.logRecords ?? []) out.push(record);
    }
  }
  return out;
}

/** A plain provider the children can call, on a DIFFERENT port to the receiver. */
async function startProvider(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end('{"id":"ch_1Mox","amount":"1200"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/charges`,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

function childEnv(receiver: OtlpReceiver, targetUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TARGET_URL: targetUrl,
    FLANJ_INTEGRATION_ID: 'acme-payments',
    FLANJ_OTLP_ENDPOINT: receiver.base, // a BASE url — normalization is part of the path under test
    FLANJ_QUIET: '1'
  };
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Wait until `check()` holds, or fail after `timeoutMs`. */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

let receiver: OtlpReceiver;
let provider: { url: string; close: () => Promise<void> };

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

function onExit(child: ChildProcess): Promise<ChildResult> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

/** Some platforms report a signal death as 128+n rather than a signal name. */
function exitSignalOf(code: number | null): string | null {
  return code === 128 + 15 ? 'SIGTERM' : null;
}

/** OTLP JSON attributes (`[{key, value:{stringValue|intValue|…}}]`) as a flat record. */
function attributesOf(record: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attribute of (record?.attributes as any[]) ?? []) {
    const value = attribute?.value ?? {};
    out[attribute.key] =
      value.stringValue ??
      (value.intValue !== undefined ? Number(value.intValue) : undefined) ??
      value.boolValue ??
      value.doubleValue;
  }
  return out;
}

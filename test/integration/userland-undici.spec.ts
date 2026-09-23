import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { onExit } from '../helpers/otlp-harness';

/**
 * A process with TWO undici copies — Node's bundled one behind global
 * `fetch()`, and a userland `undici` 8 the app depends on — must keep Node's
 * `fetch()` captured and the app's own undici calls working, in either load
 * order.
 *
 * The trap: undici 8 reads the global dispatcher from the `.2` slot, which the
 * undici Node 20–23 bundle (6.x) never writes. Loaded after `start()`, it found
 * that slot empty and installed a fresh Agent in both slots — overwriting the
 * capture layer Node's `fetch()` reads from `.1`, while the startup line still
 * said fetch() was captured. `start()` now fills `.2` with a bridge that
 * converts undici 8's handlers to the legacy API and dispatches through `.1`.
 *
 * undici 8 declares `node >= 22.19.0`, so on 20.16.0 and 22.3.0 the situation
 * cannot arise and the probe does not run; every other CI line runs it.
 */

const repoRoot = resolve(__dirname, '../..');
const sdkEntry = resolve(repoRoot, 'dist/index.js');
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc');
const probe = resolve(repoRoot, 'test/fixtures/userland-undici/probe.cjs');

const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
const undici8Supported = major > 22 || (major === 22 && minor >= 19);

interface ProbeResult {
  undiciVersion: string;
  capturing: boolean;
  records: string[];
  bodies: Record<string, { ok: boolean; url: string }>;
}

beforeAll(() => {
  execFileSync(process.execPath, [tsc, '-b'], { cwd: repoRoot, stdio: 'pipe' });
  expect(existsSync(sdkEntry), `${sdkEntry} was not built`).toBe(true);
}, 120_000);

async function runProbe(order: string): Promise<ProbeResult> {
  const child = spawn(process.execPath, [probe], {
    env: { ...process.env, PROBE_ORDER: order, SDK_ENTRY: sdkEntry },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = await onExit(child);
  expect(result.stderr, `probe stderr (${order})`).toBe('');
  expect(result.code, `the probe child must exit cleanly (${order})`).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) as string) as ProbeResult;
}

describe.runIf(undici8Supported).each(['after-start', 'before-start'])('userland undici 8 loaded %s', (order) => {
  let probeResult: ProbeResult;

  beforeAll(async () => {
    probeResult = await runProbe(order);
  }, 60_000);

  it('is the undici line that reads the .2 slot', () => {
    expect(probeResult.undiciVersion.split('.')[0]).toBe('8');
  });

  it("the app's own undici calls still work", () => {
    expect(probeResult.bodies.undiciFetch).toEqual({ ok: true, url: '/undici-fetch' });
    expect(probeResult.bodies.undiciRequest).toEqual({ ok: true, url: '/undici-request' });
    expect(probeResult.bodies.nodeFetch).toEqual({ ok: true, url: '/node-fetch' });
  });

  it("Node's global fetch() is still captured, and the startup claim stays true", () => {
    expect(probeResult.capturing).toBe(true);
    expect(probeResult.records).toContain('GET /node-fetch');
  });

  it('each call through the global dispatcher is captured exactly once', () => {
    expect(probeResult.records).toEqual(['GET /node-fetch', 'GET /undici-fetch', 'POST /undici-request']);
  });
});

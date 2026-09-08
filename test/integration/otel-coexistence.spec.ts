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
 * The SDK must run NEXT TO an existing OpenTelemetry setup — that is the whole
 * deployment story — and for two releases it did not.
 *
 * Both `@opentelemetry/instrumentation-http` and Flanj patch `request`/`get` and
 * `Server.prototype.emit` on the same core modules, and OTel's
 * `InstrumentationBase._wrap` is `isWrapped → _unwrap → wrap`: it REMOVES the
 * wrapper it finds before installing its own. Flanj inherited that method, so it
 * tore out OTel's wrappers; and because `InstrumentationBase` also instantiates
 * a require-in-the-middle singleton whose cache Flanj's own module lookups then
 * filled, starting Flanj FIRST stopped OTel's patch from ever running. Either
 * order, the loser was silent. Measured on this fixture before the fix:
 *
 *   order        OTel spans   flanj records
 *   otel-only        4              0
 *   flanj-only       0              4
 *   otel-first       0              4     <- OTel silenced
 *   flanj-first      0              4     <- OTel silenced
 *   esm preload      0              4     <- OTel silenced
 *
 * The fix stacks the wrapper instead of replacing it (`wrap-layer.ts`) and drops
 * OTel's `InstrumentationBase` for a local base that installs no module hooks
 * (`flanj-instrumentation.ts`). These run REAL children: the whole defect lives
 * in module-loading order, which an in-process vitest suite cannot reproduce.
 */

const repoRoot = resolve(__dirname, '../..');
const registerEntry = resolve(repoRoot, 'dist/register.js');
const sdkEntry = resolve(repoRoot, 'dist/index.js');
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc');
const fixtures = resolve(repoRoot, 'test/fixtures/otel-coexistence');
const esmApp = resolve(repoRoot, 'test/fixtures/esm-named-import/entry.mjs');

/** What one probe child reports: OTel's finished spans and Flanj's captured calls. */
interface ProbeResult {
  spans: { name: string; kind: number }[];
  flanjRecords: { direction: string; method: string; target: string }[];
}

/** OTel span kinds (`@opentelemetry/api`): 1 = SERVER, 2 = CLIENT. */
const SERVER_KIND = 1;
const CLIENT_KIND = 2;

beforeAll(() => {
  // The children run the BUILT entry, so build it (`tsc -b` is a no-op when current).
  execFileSync(process.execPath, [tsc, '-b'], { cwd: repoRoot, stdio: 'pipe' });
  expect(existsSync(sdkEntry), `${sdkEntry} was not built`).toBe(true);
}, 120_000);

/**
 * Run `probe.cjs` once in one registration order. It registers OTel's
 * HttpInstrumentation against an InMemorySpanExporter and/or Flanj's `start()`,
 * then drives one POST (through `http.request`) and one GET (through `http.get`,
 * whose OTel patch calls the request function it captured rather than the
 * module's current one) against its own loopback server.
 */
async function runProbe(order: string): Promise<ProbeResult> {
  const child = spawn(process.execPath, [resolve(fixtures, 'probe.cjs')], {
    env: { ...process.env, PROBE_ORDER: order, SDK_ENTRY: sdkEntry },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = await onExit(child);
  expect(result.stderr, `probe stderr (${order})`).toBe('');
  expect(result.code, `the probe child must exit cleanly (${order})`).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) as string) as ProbeResult;
}

describe('running next to @opentelemetry/instrumentation-http', () => {
  let otelOnly: ProbeResult;
  let flanjOnly: ProbeResult;
  let otelFirst: ProbeResult;
  let flanjFirst: ProbeResult;

  beforeAll(async () => {
    // Sequential, not parallel: each child binds a port and the assertions
    // compare counts, so a flaky neighbour would read as a coexistence failure.
    otelOnly = await runProbe('otel-only');
    flanjOnly = await runProbe('flanj-only');
    otelFirst = await runProbe('otel-first');
    flanjFirst = await runProbe('flanj-first');
  }, 120_000);

  it('records, alone, the baseline both orders are measured against', () => {
    // One client + one server span per call; one client + one server record per call.
    expect(otelOnly.spans).toHaveLength(4);
    expect(otelOnly.flanjRecords).toHaveLength(0);
    expect(flanjOnly.flanjRecords).toHaveLength(4);
    expect(flanjOnly.spans).toHaveLength(0);
  });

  it('leaves OTel recording its http spans when OTel registered FIRST', () => {
    expect(otelFirst.spans).toHaveLength(otelOnly.spans.length);
    expect(otelFirst.spans.filter((s) => s.kind === CLIENT_KIND)).toHaveLength(2);
    expect(otelFirst.spans.filter((s) => s.kind === SERVER_KIND)).toHaveLength(2);
  });

  it('leaves OTel recording its http spans when FLANJ started first', () => {
    expect(flanjFirst.spans).toHaveLength(otelOnly.spans.length);
    expect(flanjFirst.spans.filter((s) => s.kind === CLIENT_KIND)).toHaveLength(2);
    expect(flanjFirst.spans.filter((s) => s.kind === SERVER_KIND)).toHaveLength(2);
  });

  it('still captures every call itself, in either order', () => {
    expect(otelFirst.flanjRecords).toEqual(flanjOnly.flanjRecords);
    expect(flanjFirst.flanjRecords).toEqual(flanjOnly.flanjRecords);
  });

  it('emits exactly one record per call — stacking on OTel neither drops nor doubles', () => {
    for (const probe of [otelFirst, flanjFirst]) {
      const client = probe.flanjRecords.filter((r) => r.direction === 'client');
      const server = probe.flanjRecords.filter((r) => r.direction === 'server');
      expect(client.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
      expect(server.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    }
  });

  it('captures the `http.get` call, whose OTel patch bypasses the module `request`', () => {
    // OTel's `get` wrapper calls the request function it captured at patch time,
    // not `http.request` — so a Flanj layer on `request` alone would miss it
    // (or, wrapped on both, could see it twice).
    for (const probe of [otelFirst, flanjFirst]) {
      expect(probe.flanjRecords.filter((r) => r.direction === 'client' && r.method === 'GET')).toHaveLength(1);
      expect(probe.spans.filter((s) => s.kind === CLIENT_KIND && s.name === 'GET')).toHaveLength(1);
    }
  });
});

describe('when OTel’s http instrumentation is disabled at runtime', () => {
  it('loses the layer OTel popped, and gets it back from disable() + enable()', async () => {
    // `shimmer.unwrap` restores the OUTERMOST wrapper's original, so OTel's own
    // `disable()` pops OURS and leaves OTel's installed. Everyone who patches
    // this way shares that; the README documents it, and this holds the two
    // numbers the documented recovery rests on.
    const child = spawn(process.execPath, [resolve(fixtures, 'recover-after-otel-disable.cjs')], {
      env: { ...process.env, SDK_ENTRY: sdkEntry },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const result = await onExit(child);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const counts = JSON.parse(result.stdout.trim().split('\n').at(-1) as string) as {
      whileEvicted: number;
      afterReenable: number;
    };

    expect(counts.whileEvicted).toBe(0);
    // One egress + one ingress record for the call driven after re-enabling.
    expect(counts.afterReenable).toBe(2);
  }, 60_000);
});

describe('ESM preload under OTel’s import-in-the-middle hook', () => {
  let receiver: OtlpReceiver;
  let provider: Provider;

  beforeAll(async () => {
    expect(existsSync(registerEntry), `${registerEntry} was not built`).toBe(true);
    receiver = await startReceiver();
    provider = await startProvider();
  }, 120_000);

  afterAll(async () => {
    await receiver.close();
    await provider.close();
  });

  it('records OTel spans AND flanj rows for an app whose named imports predate both', async () => {
    // The documented combination when OTel's ESM loader hook is in play (see the
    // README): the hook first, then OTel's own setup, then the Flanj preload.
    // The app (`entry.mjs`) imports `{ request, get, createServer }` from
    // node:http before touching either SDK.
    const before = receiver.records.length;
    const child = spawn(
      process.execPath,
      [
        '--import',
        '@opentelemetry/instrumentation/hook.mjs',
        '--import',
        pathToFileURL(resolve(fixtures, 'otel-preload.mjs')).href,
        '--import',
        pathToFileURL(registerEntry).href,
        esmApp
      ],
      { cwd: repoRoot, env: childEnv(receiver, provider.url), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const result = await onExit(child);

    expect(result.stderr).toBe('');
    expect(result.code, 'the child must exit cleanly').toBe(0);

    const spansLine = result.stdout.split('\n').find((line) => line.startsWith('__SPANS__'));
    expect(spansLine, 'the OTel preload must report its spans').toBeDefined();
    const spans = JSON.parse((spansLine as string).slice('__SPANS__'.length)) as {
      name: string;
      kind: number;
      target?: string;
    }[];

    // Three egress calls (POST + GET to the provider, GET to the app's own
    // server) and one ingress hit on that server — the same four the SDK
    // captures alone in `esm-named-import.spec.ts`.
    expect(spans.filter((s) => s.kind === CLIENT_KIND)).toHaveLength(3);
    expect(spans.filter((s) => s.kind === SERVER_KIND)).toHaveLength(1);

    await waitFor(() => receiver.records.length - before >= 4);
    const rows = receiver.records.slice(before).map(attributesOf);
    expect(rows.filter((a) => a['flanj.direction'] === 'client')).toHaveLength(3);
    expect(rows.filter((a) => a['flanj.direction'] === 'server')).toHaveLength(1);
  }, 60_000);
});

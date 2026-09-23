import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { onExit } from '../helpers/otlp-harness';

/**
 * Global `fetch()` capture must run NEXT TO `@opentelemetry/instrumentation-undici`,
 * in either registration order, the same promise the http path keeps with
 * `@opentelemetry/instrumentation-http` (`otel-coexistence.spec.ts`).
 *
 * The two hook different layers — OTel subscribes to undici's
 * `diagnostics_channel` events, Flanj composes an interceptor onto the global
 * dispatcher — so neither can unwrap the other; this holds that with counts
 * from REAL children, and checks OTel's trace header still reaches the wire
 * with Flanj's layer in the path.
 */

const repoRoot = resolve(__dirname, '../..');
const sdkEntry = resolve(repoRoot, 'dist/index.js');
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc');
const probe = resolve(repoRoot, 'test/fixtures/otel-coexistence/fetch-probe.cjs');

interface ProbeResult {
  spans: { name: string; kind: number; traceId: string; spanId: string }[];
  flanjRecords: {
    direction: string;
    method: string;
    target: string;
    requestBody: string;
    requestHeaders: Record<string, string>;
    traceId?: string;
    spanId?: string;
  }[];
  traceparents: (string | null)[];
  parent: { traceId: string; spanId: string } | null;
}

/** OTel span kind 2 = CLIENT. */
const CLIENT_KIND = 2;

beforeAll(() => {
  execFileSync(process.execPath, [tsc, '-b'], { cwd: repoRoot, stdio: 'pipe' });
  expect(existsSync(sdkEntry), `${sdkEntry} was not built`).toBe(true);
}, 120_000);

async function runProbe(order: string): Promise<ProbeResult> {
  const child = spawn(process.execPath, [probe], {
    env: { ...process.env, PROBE_ORDER: order, SDK_ENTRY: sdkEntry, FLANJ_QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = await onExit(child);
  expect(result.stderr, `probe stderr (${order})`).toBe('');
  expect(result.code, `the probe child must exit cleanly (${order})`).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) as string) as ProbeResult;
}

const fetchRows = (p: ProbeResult) =>
  p.flanjRecords.filter((r) => r.direction === 'client').map((r) => `${r.method} ${r.target}`).sort();

describe('global fetch() next to @opentelemetry/instrumentation-undici', () => {
  let otelOnly: ProbeResult;
  let flanjOnly: ProbeResult;
  let otelFirst: ProbeResult;
  let flanjFirst: ProbeResult;

  beforeAll(async () => {
    otelOnly = await runProbe('otel-only');
    flanjOnly = await runProbe('flanj-only');
    otelFirst = await runProbe('otel-first');
    flanjFirst = await runProbe('flanj-first');
  }, 120_000);

  it('records, alone, the baseline both orders are measured against', () => {
    expect(otelOnly.spans.filter((s) => s.kind === CLIENT_KIND)).toHaveLength(2);
    expect(fetchRows(otelOnly)).toEqual([]);
    expect(fetchRows(flanjOnly)).toEqual(['GET /v1/charges/ch_1Mox', 'POST /v1/charges']);
    expect(flanjOnly.spans).toHaveLength(0);
  });

  it.each([
    ['OTel composed first', () => otelFirst],
    ['Flanj started first', () => flanjFirst]
  ])('%s: OTel still records a client span per fetch()', (_label, get) => {
    const p = get();
    expect(p.spans.filter((s) => s.kind === CLIENT_KIND)).toHaveLength(2);
    expect(p.spans.map((s) => s.name).sort()).toEqual(otelOnly.spans.map((s) => s.name).sort());
  });

  it.each([
    ['OTel composed first', () => otelFirst],
    ['Flanj started first', () => flanjFirst]
  ])('%s: Flanj still emits exactly one record per fetch(), with its body', (_label, get) => {
    const p = get();
    expect(fetchRows(p)).toEqual(fetchRows(flanjOnly));
    const post = p.flanjRecords.find((r) => r.direction === 'client' && r.method === 'POST');
    expect(post?.requestBody).toBe('{"amount":1200}');
  });

  it.each([
    ['OTel composed first', () => otelFirst],
    ['Flanj started first', () => flanjFirst]
  ])("%s: OTel's traceparent still reaches the wire", (_label, get) => {
    const p = get();
    expect(p.traceparents).toHaveLength(2);
    for (const tp of p.traceparents) expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it.each([
    ['OTel composed first', () => otelFirst],
    ['Flanj started first', () => flanjFirst]
  ])('%s: the record carries the traceparent that went on the wire (read at response time)', (_label, get) => {
    // OTel adds `traceparent` in undici's request:create channel, AFTER Flanj's
    // interceptor has run; the http path reads outgoing headers at response
    // time and sees it, so the fetch path must too.
    const p = get();
    const sent = p.flanjRecords
      .filter((r) => r.direction === 'client')
      .map((r) => r.requestHeaders['traceparent'])
      .sort();
    expect(sent).toHaveLength(2);
    expect(sent).toEqual([...p.traceparents].sort());
  });

  it.each([
    ['OTel composed first', () => otelFirst],
    ['Flanj started first', () => flanjFirst]
  ])("%s: the record carries the app's span context, not OTel's undici client span", (_label, get) => {
    // The interceptor runs before OTel's undici span exists, so the record holds
    // the context active at dispatch — the app's parent span — exactly as the
    // http path does. Pinned so a reordering cannot flip it silently.
    const p = get();
    expect(p.parent).not.toBeNull();
    const clientSpanIds = p.spans.filter((s) => s.kind === CLIENT_KIND).map((s) => s.spanId);
    for (const r of p.flanjRecords.filter((x) => x.direction === 'client')) {
      expect(r.traceId).toBe(p.parent?.traceId);
      expect(r.spanId).toBe(p.parent?.spanId);
      expect(clientSpanIds).not.toContain(r.spanId);
    }
    // ...and OTel's client spans are children in that same trace.
    for (const s of p.spans.filter((x) => x.kind === CLIENT_KIND)) expect(s.traceId).toBe(p.parent?.traceId);
  });
});

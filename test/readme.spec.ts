import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The README used to say what the SDK does and jump straight to License: no
 * install line, no init snippet, no env-var table, no endpoint format, no verify
 * step, no ESM/CJS note, no Node version — and, worse, it promised "the HTTP
 * calls your service makes" while global `fetch`/undici are deliberately NOT
 * captured. A developer on Node 18+ `fetch` therefore got zero rows and zero
 * warnings, with an `axios` call beside it appearing normally.
 *
 * These assertions are the floor: they do not police prose, only that the facts
 * a first-run developer needs are actually present.
 */

const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');
const lower = readme.toLowerCase();
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
  engines?: { node?: string };
};

describe('README — first-run essentials', () => {
  // The "Nothing threw. Nothing 500'd…" lead is RETIRED on every surface — it restated one point
  // three times, spoke REST on an MCP product and buried its one new idea. The README opens with
  // the current lines instead, and no variant of the old one may return.
  it('opens with the current lead, and the retired "Nothing threw" line appears nowhere', () => {
    expect(readme).toContain("**Your integration didn't break. It started being wrong.**");
    expect(readme).toContain("Every call succeeded. That's why nothing caught it.");
    const lower = readme.toLowerCase();
    for (const retired of ['nothing threw', "500'd", 'nothing 500', '200 ok and a field', 'a field was renamed']) {
      expect(lower, retired).not.toContain(retired);
    }
  });

  it('opens with a Quick start, before the deep material', () => {
    const quickStart = readme.indexOf('## Quick start');
    expect(quickStart).toBeGreaterThan(-1);
    expect(quickStart).toBeLessThan(readme.indexOf('## Status'));
    expect(quickStart).toBeLessThan(readme.indexOf('## License'));
  });

  it('gives an install line and the zero-code run line', () => {
    expect(readme).toContain('npm install @flanj/sdk');
    expect(readme).toContain('node -r @flanj/sdk/register');
  });

  it('documents the endpoint in its explicit /v1/logs form', () => {
    expect(readme).toContain('FLANJ_OTLP_ENDPOINT');
    expect(readme).toContain('http://localhost:4318/v1/logs');
  });

  it('documents the environment variables with their defaults', () => {
    for (const key of [
      'FLANJ_OTLP_ENDPOINT',
      'OTEL_SERVICE_NAME',
      'FLANJ_BODY_CAP_BYTES',
      'FLANJ_IGNORE_URLS',
      'FLANJ_TRUSTED_PROXIES'
    ]) {
      expect(readme, `${key} is not documented`).toContain(key);
    }
    expect(readme).toContain('flanj-sdk'); // the default that bites when nothing else names the service
  });

  it('gives a verify step: the collector health route, then Traffic', () => {
    expect(readme).toContain('/api/health');
    expect(readme).toContain('Traffic');
  });

  /**
   * The collector README now offers two run blocks — Kubernetes (preferred) and
   * Docker — and the old single "laptop" anchor is gone. Quick start must point
   * at both, by their own anchors, not at the repo root, which would leave the
   * reader to find the run command themselves (flanj-io/sdk#35 was the original
   * version of this gap).
   *
   * Locked here the same way the Node floor is: this is the SDK half of a
   * two-repo pair, and a test can only hold this half.
   */
  it('sends the reader to both collector run blocks, not the repo root, for the run commands', () => {
    const quickStart = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('### Configuration'));
    expect(
      quickStart,
      'Quick start needs the collector README Kubernetes anchor, not a bare repo link'
    ).toContain('https://github.com/flanj-io/collector#run-it-on-kubernetes');
    expect(
      quickStart,
      'Quick start needs the collector README Docker anchor, not a bare repo link'
    ).toContain('https://github.com/flanj-io/collector#run-it-with-docker');
    expect(quickStart, 'the retired laptop anchor must not return').not.toContain('#run-it-on-a-laptop');
    // A repo-root link elsewhere (the feature list naming the consumer of the
    // wire convention, or the chart README under a /tree/ path) is fine — it is
    // not telling anyone how to run anything.
    expect(
      quickStart.includes('](https://github.com/flanj-io/collector)'),
      'a bare repo-root link in Quick start leaves the reader to find the run command themselves'
    ).toBe(false);
  });

  /**
   * The collector's UI used to need a manually-run sidecar because its Docker
   * image bound container loopback only. Docker Compose now starts that bridge
   * itself, and on Kubernetes the equivalent is a `kubectl port-forward` — so the
   * "sidecar" framing (and its unqualified "collector's UI is loopback-only"
   * claim) no longer describes either path and must not return.
   */
  it('explains recovery for both the Docker and Kubernetes verify paths, without stale sidecar wording', () => {
    const verify = readme.slice(readme.indexOf('**Verify**'), readme.indexOf('### Configuration'));
    expect(verify, 'no Verify section found').not.toHaveLength(0);
    expect(verify.toLowerCase(), 'sidecar wording is retired').not.toContain('sidecar');
    expect(verify).toContain('http://127.0.0.1:5335');
    expect(verify).toContain('docker compose up -d');
    expect(verify).toContain('kubectl -n flanj port-forward');
  });

  it('says which module systems are supported', () => {
    expect(lower).toContain('esm');
    expect(lower).toContain('cjs');
  });

  /**
   * This assertion used to read `/Node\s*`?\^?18\.19/`, which LOCKED a claim the
   * code could not honour: the capture path reaches core `http` through
   * `process.getBuiltinModule` (Node 20.16.0 / 22.3.0), so `start()` threw a
   * TypeError on every 18.x. The spec pinned the README, the README matched
   * `engines`, and all three were wrong together. Comparing the README against
   * `engines.node` instead means the requirement can only ever be restated, never
   * independently invented — whatever npm enforces is what the reader is told.
   */
  it('states the supported Node range byte-for-byte from package.json engines', () => {
    const range = pkg.engines?.node;
    expect(range, 'package.json declares no engines.node').toBeTruthy();
    expect(readme, `README does not carry the engines range ${range}`).toContain(`Node \`${range}\``);
  });

  it('names the accessor that sets the floor, so the number is not arbitrary', () => {
    expect(readme).toContain('process.getBuiltinModule');
  });

  /**
   * The load patterns are part of the contract: the `--import` preload, and that
   * an ESM named import of node:http taken BEFORE the SDK started is captured
   * (test/integration/esm-named-import.spec.ts proves it; the README must say it).
   */
  it('documents the --import preload and the ESM named-import form', () => {
    expect(readme).toContain('node --import @flanj/sdk/register');
    expect(readme).toContain("import { request, get } from 'node:http'");
    expect(lower).toContain('before the sdk started');
  });

  /**
   * The product's pitch is running next to an existing OTel setup, and for two
   * releases that silently did not work (whoever patched `node:http` second tore
   * the other's wrapper out). The README must state that both orders are
   * supported, and the one ordering rule under OTel's ESM loader hook.
   */
  it('documents coexistence with OpenTelemetry, in either registration order', () => {
    const section = readme.slice(readme.indexOf('### Running next to OpenTelemetry'));
    expect(section, 'no OpenTelemetry coexistence section').not.toBe(readme);
    expect(section).toContain('@opentelemetry/instrumentation-http');
    expect(section.toLowerCase()).toContain('either registration order');
    expect(section).toContain('@opentelemetry/instrumentation/hook.mjs');
  });

  /**
   * The load-bearing one: the gap between "the HTTP calls your service makes"
   * and what is actually instrumented must be stated, by name.
   */
  it('lists what IS captured, naming the node:http client libraries', () => {
    expect(readme).toContain('node:http');
    for (const client of ['axios', 'got', 'node-fetch', 'superagent']) {
      expect(readme, `${client} is not named as captured`).toContain(client);
    }
  });

  /**
   * The ingress trap: behind a load balancer every inbound call is internal
   * (metadata-only) until the proxy is declared trusted. Silent, like the fetch
   * gap — so the README must say it, next to the variable that fixes it.
   */
  it('says inbound calls behind a proxy classify internal until FLANJ_TRUSTED_PROXIES is set', () => {
    const row = readme.split('\n').find((line) => line.includes('`FLANJ_TRUSTED_PROXIES`'));
    expect(row, 'no FLANJ_TRUSTED_PROXIES row').toBeTruthy();
    expect(row).toContain('X-Forwarded-For');
    expect(row?.toLowerCase()).toContain('internal');
    expect(lower).toContain('behind a reverse proxy');
  });

  it('lists what is NOT captured, naming fetch, undici and node:http2', () => {
    const notCaptured = readme.slice(readme.indexOf('**Not captured yet**'));
    expect(notCaptured, 'no Not-captured section').not.toBe(readme);
    expect(notCaptured).toContain('fetch');
    expect(notCaptured).toContain('undici');
    expect(notCaptured).toContain('node:http2');
  });

  it('warns that the fetch gap is silent, not loud', () => {
    const notCaptured = readme.slice(readme.indexOf('**Not captured yet**'));
    expect(notCaptured.toLowerCase()).toContain('zero rows');
  });
});

/**
 * The two SDKs' READMEs are built on ONE skeleton: the same sections in the same
 * order, differing only where the language or the HTTP half forces it. They had
 * drifted into two unrelated documents describing what is very nearly the same
 * product, which is how a reader concludes the SDKs differ far more than they do.
 *
 * Each repo can only pin its own half, so this is the TypeScript half: the
 * ordered heading list, with the three entries the Python README does not share
 * marked as such. Adding, removing or reordering a section here means doing the
 * same in `flanj-io/sdk-py`'s README (its `tests/test_readme.py` pins the twin).
 */
describe('README — the shared cross-language skeleton', () => {
  it('carries the agreed sections, in the agreed order', () => {
    const headings = readme
      .split('\n')
      .filter((line) => /^#{1,3} /.test(line))
      .map((line) => line.replace(/^#+ /, '').trim());

    expect(headings).toEqual([
      '@flanj/sdk',
      'Quick start',
      'On Kubernetes', // inside Quick start: the chart's fixed-name Service + the workload patch
      'ESM, CJS, and shutdown', // language-specific: the Python README has "Load flanj first" here
      'MCP quick start',
      'Instrumenting a client yourself',
      'Configuration',
      'Running next to OpenTelemetry', // HTTP-only: no Python counterpart
      'What is captured',
      'MCP clients: the contract arrives with the traffic',
      'It stays out of the way',
      'Also in this distribution', // packaging-specific: the second npm package
      'Status',
      'Development',
      'Security',
      'License'
    ]);
  });

  /**
   * MCP used to be a bullet under "Also in this distribution" — three quarters of
   * the way down, under a heading that reads like an appendix. It is half of what
   * this SDK captures and the whole of what the Python SDK captures, so it gets a
   * quick start of its own, above the fold of the deep HTTP material.
   */
  it('gives MCP a quick start of its own, before "What is captured"', () => {
    const mcpQuickStart = readme.indexOf('### MCP quick start');
    expect(mcpQuickStart).toBeGreaterThan(-1);
    expect(mcpQuickStart).toBeLessThan(readme.indexOf('## What is captured'));

    const section = readme.slice(mcpQuickStart, readme.indexOf('### Instrumenting a client yourself'));
    // The fields a reader has to know an MCP call records, and the two things that
    // surprise people: the client-generated id, and where the service name shows.
    for (const fact of [
      'structuredContent',
      'isError',
      '_meta',
      'client-generated',
      'error',
      'tasks/get',
      'refetchOnListChanged',
      'npx @stripe/mcp@0.2.1'
    ]) {
      expect(section, `the MCP quick start does not mention ${fact}`).toContain(fact);
    }
    expect(section).toContain('never sent to the control plane');
  });

  it('documents the capture-failure warning and its variable', () => {
    expect(readme).toContain('FLANJ_SILENCE_CAPTURE_WARNINGS');
    expect(lower).toContain('your application is unaffected');
  });

  it('documents handle.instrumentMcp, the explicit per-client entry', () => {
    expect(readme).toContain('instrumentMcp(client)');
  });
});

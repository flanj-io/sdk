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

describe('README — first-run essentials', () => {
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
      'FLANJ_INTEGRATION_ID',
      'FLANJ_OTLP_ENDPOINT',
      'OTEL_SERVICE_NAME',
      'FLANJ_BODY_CAP_BYTES',
      'FLANJ_IGNORE_URLS',
      'FLANJ_TRUSTED_PROXIES'
    ]) {
      expect(readme, `${key} is not documented`).toContain(key);
    }
    expect(readme).toContain('unknown-integration'); // the default that bites when unset
  });

  it('gives a verify step: the collector health route, then Traffic', () => {
    expect(readme).toContain('/api/health');
    expect(readme).toContain('Traffic');
  });

  it('says which module systems and Node versions are supported', () => {
    expect(lower).toContain('esm');
    expect(lower).toContain('cjs');
    expect(readme).toMatch(/Node\s*`?\^?18\.19/);
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

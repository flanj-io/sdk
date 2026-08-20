import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import child_process from 'node:child_process';
import { createRedactor, enhance } from '../src/index';

/**
 * ZERO-EXTERNAL-CALLS sentinel. The floor must never do I/O: it runs on every captured body,
 * before anything is stored or transmitted, inside the customer's process. This test arms a
 * sentinel on every Node network/DNS/process primitive, runs the ENTIRE fixture battery through
 * both entry points plus the enhancer, and fails if anything was touched. The library eval ran
 * this by hand once; this makes it permanent in CI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(resolve(here, '../../../contracts/redaction-fixtures.json'), 'utf8'));
const vectors = JSON.parse(readFileSync(resolve(here, '../../../contracts/redaction-vectors.json'), 'utf8'));

const calls: string[] = [];
const originals: Array<() => void> = [];

function arm<T extends object, K extends keyof T>(obj: T, key: K, label: string): void {
  const original = obj[key];
  (obj as Record<K, unknown>)[key] = ((...args: unknown[]) => {
    calls.push(`${label}(${args.map((a) => (typeof a === 'string' ? a : typeof a)).join(', ')})`);
    throw new Error(`network sentinel: ${label} called from the redaction floor`);
  }) as T[K];
  originals.push(() => {
    (obj as Record<K, unknown>)[key] = original;
  });
}

describe('redaction floor makes zero external calls', () => {
  beforeAll(() => {
    arm(http, 'request', 'http.request');
    arm(http, 'get', 'http.get');
    arm(https, 'request', 'https.request');
    arm(https, 'get', 'https.get');
    arm(net, 'connect', 'net.connect');
    arm(net, 'createConnection', 'net.createConnection');
    arm(dns, 'lookup', 'dns.lookup');
    arm(dns, 'resolve', 'dns.resolve');
    arm(dns.promises, 'lookup', 'dns.promises.lookup');
    arm(child_process, 'exec', 'child_process.exec');
    arm(child_process, 'spawn', 'child_process.spawn');
    arm(globalThis as { fetch: typeof fetch }, 'fetch', 'fetch');
  });

  afterAll(() => {
    for (const restore of originals) restore();
  });

  it('runs every fixture and vector through both entry points without touching the network', () => {
    const redactor = createRedactor({ includeIp: true });
    for (const c of fixtures.cases) {
      if (c.kind === 'json') {
        redactor.redact(c.input);
        redactor.redactText(JSON.stringify(c.input));
        if (c.enhancer) enhance(redactor.redact(c.input).redacted, c.enhancer.spec);
      } else {
        redactor.redactText(c.input);
      }
    }
    for (const v of vectors.cases) redactor.redactText(v.input);
    expect(calls).toEqual([]);
  });
});

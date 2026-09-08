import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as http from 'node:http';
import { SUPPORTED_NODE_RANGE, assertSupportedNodeVersion, builtinModule } from './builtin-module';
import { start } from '../index';

/**
 * The regression this file exists for: `package.json` promised
 * `^18.19.0 || >=20.6.0` (copied from OpenTelemetry's own engines) while the
 * capture path reaches core `http` through `process.getBuiltinModule`, which
 * landed only in Node 20.16.0 / 22.3.0. On every runtime in the gap — all of
 * 18.x, 20.6–20.15, all of 21.x, 22.0–22.2 — `start()` threw
 * `TypeError: Cannot read properties of undefined (reading 'call')` from a
 * `dist/` path: an install that satisfied `engines` and could not run.
 *
 * Measured on this machine (2026-09-08), one real http call under the built
 * entry: 18.14.0 ✗ · 20.15.1 ✗ · 20.16.0 ✓ · 20.20.2 ✓ · 21.6.0 ✗ · 22.2.0 ✗ ·
 * 22.3.0 ✓ · 22.22.1 ✓ · 23.3.0 ✓ — exactly `^20.16.0 || >=22.3.0`.
 */

/** Run `fn` on a process that looks like Node 18/20.15/21/22.2: no accessor. */
function withoutBuiltinModuleAccess<T>(fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');
  // Some runtimes expose it on the prototype; shadow it either way.
  Object.defineProperty(process, 'getBuiltinModule', { value: undefined, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (descriptor) Object.defineProperty(process, 'getBuiltinModule', descriptor);
    else delete (process as Partial<NodeJS.Process>).getBuiltinModule;
  }
}

describe('SUPPORTED_NODE_RANGE', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
    engines?: { node?: string };
  };

  /**
   * The whole defect was a version claim drifting from the code. Lock the
   * constant the error message quotes to the field npm actually enforces.
   */
  it('is byte-for-byte the package.json engines.node range', () => {
    expect(pkg.engines?.node).toBe(SUPPORTED_NODE_RANGE);
  });

  it('excludes the runtimes that have no process.getBuiltinModule', () => {
    // 21.x has no accessor at all, so the 20 clause MUST be a caret, not >=.
    expect(SUPPORTED_NODE_RANGE).toBe('^20.16.0 || >=22.3.0');
  });
});

describe('assertSupportedNodeVersion', () => {
  it('is a no-op on a runtime that exposes the accessor', () => {
    expect(() => assertSupportedNodeVersion()).not.toThrow();
  });

  it('throws one sentence naming the requirement, not a TypeError', () => {
    withoutBuiltinModuleAccess(() => {
      let thrown: unknown;
      try {
        assertSupportedNodeVersion();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(TypeError);
      const message = (thrown as Error).message;
      expect(message).toContain('@flanj/sdk requires Node');
      expect(message).toContain(SUPPORTED_NODE_RANGE);
      expect(message).toContain('process.getBuiltinModule');
      expect(message, 'names the version actually running').toContain(process.version);
      expect(message.split('\n')).toHaveLength(1);
    });
  });
});

describe('builtinModule', () => {
  it('returns the live, mutable core exports the patch mutates', () => {
    const live = builtinModule('node:http');
    // The same singleton `require`/`import` hand out — patching it is what makes
    // property-at-call-time callers see the wrapper.
    expect(live).toBe(process.getBuiltinModule('node:http'));
    expect(Object.getOwnPropertyDescriptor(live, 'request')?.configurable).toBe(true);
    expect(typeof (live as unknown as typeof http).request).toBe('function');
  });

  it('carries the same clear error when the accessor is absent', () => {
    withoutBuiltinModuleAccess(() => {
      expect(() => builtinModule('node:http')).toThrow(/@flanj\/sdk requires Node/);
    });
  });
});

describe('start() on an unsupported runtime', () => {
  /**
   * The user-visible half: the throw must come from `start()` itself, before any
   * exporter, provider or patch exists — an app that catches it and carries on
   * must not be left with a half-registered SDK (the same reasoning that puts
   * the `trustedProxies` parse first).
   */
  it('fails loudly, before anything is registered or patched', () => {
    withoutBuiltinModuleAccess(() => {
      expect(() => start({ integration: 'unsupported-node' })).toThrow(
        new RegExp(`@flanj/sdk requires Node \\^20\\.16\\.0 \\|\\| >=22\\.3\\.0`)
      );
    });
  });

  it('leaves node:http unpatched when it refuses to start', () => {
    const before = http.request;
    withoutBuiltinModuleAccess(() => {
      expect(() => start({ integration: 'unsupported-node' })).toThrow();
    });
    expect(http.request).toBe(before);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, realpathSync } from 'node:fs';
import { resolveAppName } from './resolve-app-name';
import { start, type FlanjHandle } from './index';

/**
 * `service.name` default order (CONTRACTS §2, 2026-09-19): the `serviceName`
 * option, then `OTEL_SERVICE_NAME`, then the app's own name, then `"flanj-sdk"`.
 * The app's-own-name step is covered exhaustively (pure, injected fs) in
 * `resolve-app-name.spec.ts`; this file locks the two option/env precedence
 * links of the chain, plus the hard removal of `integration`.
 */

const NOOP_PROCESSOR = {
  onEmit(): void {
    /* never leaves the process */
  },
  forceFlush: async () => undefined,
  shutdown: async () => undefined
};

describe('start() — service name resolution precedence', () => {
  let handle: FlanjHandle | undefined;
  const originalEnv = process.env.OTEL_SERVICE_NAME;

  afterEach(async () => {
    await handle?.shutdown();
    handle = undefined;
    if (originalEnv === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = originalEnv;
  });

  it('an explicit serviceName option beats OTEL_SERVICE_NAME', () => {
    process.env.OTEL_SERVICE_NAME = 'env-name';
    handle = start({ serviceName: 'explicit-name', processor: NOOP_PROCESSOR });
    expect(handle.serviceName).toBe('explicit-name');
  });

  it('OTEL_SERVICE_NAME beats the resolved app name when no option is given', () => {
    process.env.OTEL_SERVICE_NAME = 'env-name';
    handle = start({ processor: NOOP_PROCESSOR });
    expect(handle.serviceName).toBe('env-name');
  });

  it('an empty option or OTEL_SERVICE_NAME counts as unset, as in the Python SDK', () => {
    const appName = resolveAppName({
      argv1: process.argv[1],
      cwd: process.cwd(),
      readFile: (p) => readFileSync(p, 'utf8'),
      realpath: (p) => realpathSync(p)
    });
    process.env.OTEL_SERVICE_NAME = '';
    handle = start({ serviceName: '', processor: NOOP_PROCESSOR });
    expect(appName).not.toBe('');
    expect(handle.serviceName).toBe(appName);
  });
});

/**
 * Type-level proof of the hard removal (no deprecated shim, no warning): TS
 * must refuse `integration` as an excess property on `StartOptions`. Never
 * called — the body exists only to be type-checked by `tsc -b` / `yarn build`.
 */
function typeOnlyStartOptionsProof(): void {
  // @ts-expect-error — `integration` was removed from StartOptions (2026-09-19); configure `serviceName` instead.
  start({ integration: 'x' });
}
void typeOnlyStartOptionsProof;

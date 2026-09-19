import { describe, it, expect } from 'vitest';
import { resolveAppName, type ResolveAppNameInput } from './resolve-app-name';

/**
 * Locks the app-name fallback of the service.name default order (CONTRACTS §2,
 * 2026-09-19): explicit serviceName option -> OTEL_SERVICE_NAME -> the app's own
 * name -> "flanj-sdk". This file covers only the pure "app's own name" step;
 * the full precedence chain is covered in index.spec.ts.
 *
 * All filesystem access is injected (a plain path -> content map) so the
 * vectors are literal and hermetic — no real temp dirs, no real cwd.
 */

function fakeInput(overrides: {
  argv1?: string;
  cwd?: string;
  files?: Record<string, string>;
  realpath?: (p: string) => string;
}): ResolveAppNameInput {
  const files = overrides.files ?? {};
  return {
    argv1: overrides.argv1,
    cwd: overrides.cwd ?? '/cwd',
    readFile: (p: string): string => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p]!;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    realpath: overrides.realpath ?? ((p: string): string => p)
  };
}

describe('resolveAppName', () => {
  it('walks up from a nested entry file to a package.json two levels up', () => {
    const result = resolveAppName(
      fakeInput({
        argv1: '/repo/a/b/entry.js',
        files: { '/repo/package.json': JSON.stringify({ name: 'root-pkg' }) }
      })
    );
    expect(result).toBe('root-pkg');
  });

  it('skips a nameless package.json between the entry and the named one', () => {
    const result = resolveAppName(
      fakeInput({
        argv1: '/repo/a/b/entry.js',
        files: {
          '/repo/a/package.json': JSON.stringify({ type: 'module' }),
          '/repo/package.json': JSON.stringify({ name: 'root-pkg' })
        }
      })
    );
    expect(result).toBe('root-pkg');
  });

  it('returns flanj-sdk when argv1 is undefined', () => {
    expect(resolveAppName(fakeInput({ argv1: undefined }))).toBe('flanj-sdk');
  });

  it('returns flanj-sdk when argv1 is "-" (REPL / node -e / node -p / stdin)', () => {
    expect(resolveAppName(fakeInput({ argv1: '-' }))).toBe('flanj-sdk');
  });

  it('falls back to a package.json above cwd when nothing is above the entry', () => {
    const result = resolveAppName(
      fakeInput({
        argv1: '/entry-root/entry.js',
        cwd: '/cwd-root/sub',
        files: { '/cwd-root/package.json': JSON.stringify({ name: 'cwd-pkg' }) }
      })
    );
    expect(result).toBe('cwd-pkg');
  });

  it('returns flanj-sdk when nothing is found anywhere', () => {
    const result = resolveAppName(fakeInput({ argv1: '/entry-root/entry.js', cwd: '/cwd-root' }));
    expect(result).toBe('flanj-sdk');
  });

  it('returns a scoped package name verbatim', () => {
    const result = resolveAppName(
      fakeInput({
        argv1: '/repo/entry.js',
        files: { '/repo/package.json': JSON.stringify({ name: '@acme/checkout' }) }
      })
    );
    expect(result).toBe('@acme/checkout');
  });

  it('skips unparseable JSON and a non-string name, keeps walking', () => {
    const result = resolveAppName(
      fakeInput({
        argv1: '/repo/a/entry.js',
        files: {
          '/repo/a/package.json': 'not json {{{',
          '/repo/package.json': JSON.stringify({ name: 42 }),
          '/package.json': JSON.stringify({ name: 'top-pkg' })
        }
      })
    );
    expect(result).toBe('top-pkg');
  });

  it('falls back to the path as given when realpath throws', () => {
    const result = resolveAppName(
      fakeInput({
        argv1: '/repo/entry.js',
        realpath: () => {
          throw new Error('ENOENT');
        },
        files: { '/repo/package.json': JSON.stringify({ name: 'root-pkg' }) }
      })
    );
    expect(result).toBe('root-pkg');
  });
});

/**
 * Resolve a specifier the way an ESM `import` would — the `import` export
 * condition, not `require` — and return its URL, SYNCHRONOUSLY.
 *
 * This is the only ES module in a CommonJS package, and it exists for one call.
 * `auto-instrument.ts` has to find the ESM build of a dual MCP package and patch
 * it inside a `--require` preload, before the application's first line runs, and
 * CommonJS has no synchronous way to ask which file an `import` would load:
 * `require.resolve` answers with the `require` condition, and `import()` is async.
 * `import.meta.resolve` is synchronous, and exists only in an ES module.
 *
 * `auto-instrument.ts` loads this file with `require()`. On a Node without
 * `require(esm)` that throws, and the caller falls back to an asynchronous
 * `import()`.
 *
 * Resolution is relative to THIS file, which sits beside `auto-instrument.js`, so
 * it walks the same `node_modules` chain as that file's own `require`.
 */
export function resolveImportUrl(specifier: string): string {
  // @ts-expect-error TS1343: this package compiles with `module: CommonJS`, under
  // which the compiler refuses `import.meta` everywhere, even in a `.mts` file it
  // emits as an ES module. The emitted `.mjs` is an ES module and `import.meta`
  // is valid there. If the compiler ever accepts this line, the directive fails
  // the build, which is the cue to delete it.
  return import.meta.resolve(specifier) as string;
}

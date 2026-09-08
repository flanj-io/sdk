import { syncBuiltinESMExports } from 'node:module';

/**
 * Push every builtin's live CJS exports back into its ESM facade.
 *
 * `enable()` patches the mutable exports object `process.getBuiltinModule`
 * returns, which reaches every caller that resolves the property at call time —
 * `http.request(...)`, `require('http').request`, a bundler's `__toESM` getter.
 * An ESM `import { request } from 'node:http'` (or `import * as http`) reads
 * something else: a slot in node:http's ESM facade that Node fills from the CJS
 * exports when the facade is created and never touches again on its own. A
 * module that took that binding BEFORE the SDK started kept calling the ORIGINAL
 * function — zero rows, no warning, with a `require`-style caller beside it
 * captured normally.
 *
 * `module.syncBuiltinESMExports()` is Node's documented hook for exactly this
 * (its docs: "so that APMs and other behavior are supported"). Because ESM
 * imports are live bindings, every importer — already evaluated or not — sees
 * the patched function the moment the facade slot is rewritten. Call it after
 * every wrap AND every unwrap, so `disable()` restores what ESM callers see too.
 *
 * Never throws: instrumentation must not break the app, and the property-lookup
 * path is patched regardless.
 */
export function syncBuiltinEsmExports(): void {
  try {
    syncBuiltinESMExports();
  } catch {
    // swallow — the caller's CJS exports patch still stands for property-lookup callers
  }
}

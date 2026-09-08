/**
 * The live, mutable exports of a core module — and the runtime precondition for
 * reaching them at all.
 *
 * `enable()` patches core `http`/`https` by mutating their exports object.
 * `import * as http` under an ESM/esbuild transform yields a read-only namespace
 * whose `request` property is non-configurable, so shimmer's `defineProperty`
 * fails against it; `process.getBuiltinModule` returns the real singleton
 * exports object, which is patchable. Patching it reaches every caller that
 * resolves the property at call time; an ESM named import or namespace taken
 * before `enable()` additionally needs the facade re-sync the client path
 * performs (see `sync-builtin-esm-exports.ts`).
 *
 * `process.getBuiltinModule` landed in Node 20.16.0 and 22.3.0 — NOT in 18.x,
 * not in 20.6–20.15, and not in 21.x. On those runtimes the accessor is simply
 * `undefined` and the whole SDK is inert, so the version is a hard requirement
 * rather than a degraded mode. It used to surface as
 * `TypeError: Cannot read properties of undefined (reading 'call')`, thrown from
 * a `dist/` path, on a `package.json` that promised those runtimes were fine.
 * Now it is one sentence naming the requirement, raised from `start()` before
 * any exporter, provider or patch exists.
 */

/** The runtimes this SDK actually runs on. MUST equal `engines.node` in package.json. */
export const SUPPORTED_NODE_RANGE = '^20.16.0 || >=22.3.0';

/** Node exposes the patchable core-module exports (i.e. this runtime is supported). */
function hasBuiltinModuleAccess(): boolean {
  return typeof (process as Partial<NodeJS.Process>).getBuiltinModule === 'function';
}

/**
 * Fail loudly, and early, on a Node that cannot be instrumented. Called first
 * thing in `start()` so the throw precedes every side effect, and again from
 * {@link builtinModule} so a directly-constructed instrumentation says the same.
 */
export function assertSupportedNodeVersion(): void {
  if (hasBuiltinModuleAccess()) return;
  throw new Error(
    `@flanj/sdk requires Node ${SUPPORTED_NODE_RANGE} — this is Node ${process.version}, which has no ` +
      `process.getBuiltinModule, the patchable core-module accessor the http/https capture patches through.`
  );
}

/** The LIVE, mutable exports of `node:http` / `node:https`. */
export function builtinModule(id: 'node:http' | 'node:https'): Record<string, unknown> {
  assertSupportedNodeVersion();
  return process.getBuiltinModule(id) as unknown as Record<string, unknown>;
}

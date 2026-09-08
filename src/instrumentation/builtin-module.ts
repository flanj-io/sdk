/**
 * The live, mutable exports of a core module — and the runtime precondition for
 * reaching them at all.
 *
 * The capture patches mutate the exports object of core `http`/`https`.
 * `import * as http` under an ESM/esbuild transform yields a read-only namespace
 * whose `request` property is non-configurable, so shimmer's `defineProperty`
 * fails against it; `process.getBuiltinModule` returns the real singleton
 * exports object, which is patchable. Patching it reaches every caller that
 * resolves the property at call time; an ESM named import or namespace taken
 * before `start()` additionally needs the facade re-sync the client path
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
 * `process.getBuiltinModule`, captured when this module first loads.
 *
 * `require-in-the-middle` — the hook an OTel `InstrumentationBase` installs —
 * patches `process.getBuiltinModule` as well as `Module.prototype.require`, and
 * every call through it CACHES the module's exports under its own key. A hook
 * that has not yet been told about `http` (because the app registers
 * `@opentelemetry/instrumentation-http` a moment later) then returns that cached
 * copy forever and never runs OTel's patch: OTel goes silent, and it was our
 * lookup that filled the cache. Taking the reference at load — before any hook
 * exists, in the preload and import-first shapes the SDK documents — means our
 * lookups never seed someone else's cache. It returns the same exports object
 * either way; the same one OTel's http instrumentation patches, so both sides'
 * wrappers end up in one call chain.
 */
const getBuiltinModule = (process as Partial<NodeJS.Process>).getBuiltinModule;

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
  // Still the LIVE check, not the snapshot: a runtime that has the accessor
  // taken away under it (the spec does exactly that) must fail the same way.
  assertSupportedNodeVersion();
  const get = getBuiltinModule ?? process.getBuiltinModule;
  return get.call(process, id) as unknown as Record<string, unknown>;
}

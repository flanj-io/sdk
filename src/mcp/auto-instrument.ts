import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { warnCaptureFailed } from '../capture-warning';
import {
  instrumentMcpClient,
  registerMcpTransportEndpoint,
  type InstrumentMcpClientOptions,
  type McpClientLike
} from './instrument-mcp-client';

const CTOR_PATCHED = Symbol.for('flanj.mcp.ctorPatched');

/**
 * Patch a Client CONSTRUCTOR so every instance self-instruments on first use
 * (the auto-patch path). The prototype's `callTool` /
 * `listTools` are shadowed by trampolines that, once per instance, pin the
 * ORIGINAL prototype methods onto the instance and run
 * {@link instrumentMcpClient} over them — after which the instance behaves
 * exactly like an explicitly wrapped client. Returns false (and changes
 * nothing) when the value is not a Client-shaped constructor. THROWS when the
 * value is Client-shaped but cannot be patched (a frozen prototype, say): the
 * caller reports that, because a client left unpatched is capture lost silently.
 */
export function patchMcpClientConstructor(ctor: unknown, options: InstrumentMcpClientOptions = {}): boolean {
  if (typeof ctor !== 'function') return false;
  const proto = (ctor as { prototype?: unknown }).prototype as
    | (Record<PropertyKey, unknown> & McpClientLike)
    | undefined;
  if (!proto || typeof proto.callTool !== 'function' || typeof proto.listTools !== 'function') return false;
  if (proto[CTOR_PATCHED] === true) return true;
  proto[CTOR_PATCHED] = true;

  const originals = { callTool: proto.callTool, listTools: proto.listTools };

  // connect() runs the initialize handshake before any tool call reaches the
  // trampolines below, so the endpoint is registered here, on the way in.
  const origConnect = proto.connect;
  if (typeof origConnect === 'function') {
    proto.connect = function (this: McpClientLike, ...args: unknown[]): Promise<unknown> {
      registerMcpTransportEndpoint(args[0], options);
      return origConnect.apply(this, args as [unknown, ...unknown[]]);
    };
  }

  const ensureInstrumented = (instance: McpClientLike): void => {
    // Pin the ORIGINALS as own props, then wrap them in place — so the wrapper
    // never recurses into the trampolines below.
    if (!Object.prototype.hasOwnProperty.call(instance, 'callTool')) {
      Object.defineProperty(instance, 'callTool', { value: originals.callTool, writable: true, configurable: true });
    }
    if (!Object.prototype.hasOwnProperty.call(instance, 'listTools')) {
      Object.defineProperty(instance, 'listTools', { value: originals.listTools, writable: true, configurable: true });
    }
    instrumentMcpClient(instance, options);
  };

  proto.callTool = function (this: McpClientLike, ...args: unknown[]): Promise<unknown> {
    try {
      ensureInstrumented(this);
    } catch {
      /* never break the app: fall through to the original */
    }
    const own = this.callTool;
    return (typeof own === 'function' && own !== proto.callTool ? own : originals.callTool)!.apply(this, args) as Promise<unknown>;
  };
  proto.listTools = function (this: McpClientLike, ...args: unknown[]): Promise<unknown> {
    try {
      ensureInstrumented(this);
    } catch {
      /* never break the app */
    }
    const own = this.listTools;
    return (typeof own === 'function' && own !== proto.listTools ? own : originals.listTools)!.apply(this, args) as Promise<unknown>;
  };
  return true;
}

/** The optional peers, and where each one keeps its client constructor. */
const CANDIDATES: { id: string; pick: (m: Record<string, unknown>) => unknown }[] = [
  { id: '@modelcontextprotocol/sdk/client/index.js', pick: (m) => m.Client },
  { id: '@modelcontextprotocol/client', pick: (m) => m.Client ?? m.McpClient ?? m.default }
];

/**
 * Each candidate is a DUAL package: its `require` condition and its `import`
 * condition are two builds, and two different `Client` class objects. These are
 * the two halves, named for the condition that reaches them.
 */
type Half = 'require' | 'import';

/**
 * What happened to one half of one candidate.
 *
 * - `patched` — the class that half exports is instrumented.
 * - `absent` — nothing to patch: the package is not installed, or no
 *   application could load that half on this runtime either.
 * - `deferred` — installed, but it could not be loaded synchronously here; the
 *   asynchronous `import()` pass takes it over.
 * - `failed` — installed and loadable, and still not patched. Every call an
 *   application makes through that class goes uncaptured, so this is reported.
 */
type HalfState =
  | { status: 'patched' | 'absent' }
  | { status: 'deferred' | 'failed'; cause: unknown };

type CandidateState = Record<Half, HalfState>;

const NOT_INSTALLED = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);
/**
 * A synchronous load of an ES module is impossible here: no `require(esm)`, a
 * top-level `await`, or — on 22.12 and 23 — a module the application's own ESM
 * graph is loading at this moment, which is what happens when the entry is
 * reached by `import '@flanj/sdk/register'` in the same file as the MCP import.
 * Newer lines load that last case synchronously too.
 */
const NOT_SYNCHRONOUSLY_LOADABLE = new Set(['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'ERR_REQUIRE_CYCLE_MODULE']);

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Patch the constructor a loaded module exports. A module that loads but offers
 * nothing patchable is a FAILURE, not an absence: the package is there, the
 * application is using it, and none of its calls would be captured.
 */
function patchLoaded(
  mod: Record<string, unknown>,
  pick: (m: Record<string, unknown>) => unknown,
  options: InstrumentMcpClientOptions
): HalfState {
  try {
    if (patchMcpClientConstructor(pick(mod), options)) return { status: 'patched' };
    return {
      status: 'failed',
      cause: new Error('it exports no Client with callTool and listTools on its prototype')
    };
  } catch (err) {
    return { status: 'failed', cause: err };
  }
}

/** The `require` half: exactly what a CommonJS application's own `require` gets. */
function patchRequireHalf(
  id: string,
  pick: (m: Record<string, unknown>) => unknown,
  options: InstrumentMcpClientOptions
): HalfState {
  try {
    require.resolve(id);
  } catch {
    return { status: 'absent' };
  }
  let mod: Record<string, unknown>;
  try {
    // A package whose `require` condition names an ES module is `require(esm)` too.
    mod = withoutRequireEsmNotice(() => requireModule(id));
  } catch (err) {
    // An ESM-only build on a runtime without `require(esm)`: a CommonJS
    // application cannot `require` it either, so there is no class to miss.
    if (NOT_SYNCHRONOUSLY_LOADABLE.has(codeOf(err) ?? '')) return { status: 'absent' };
    return { status: 'failed', cause: err };
  }
  return patchLoaded(mod, pick, options);
}

/**
 * The resolver for the `import` condition (`resolve-import-url.mts`), loaded on
 * first use. `undefined` when this runtime has no `require(esm)` — or when this
 * file is running from source, where the resolver is not compiled — and the
 * `import` half must wait for {@link registerMcpAutoInstrumentation}.
 */
let importResolver: ((specifier: string) => string) | null | undefined = null;

function resolveImportUrlSync(): ((specifier: string) => string) | undefined {
  if (importResolver === null) {
    try {
      const mod = withoutRequireEsmNotice(() => requireModule(join(__dirname, 'resolve-import-url.mjs')));
      importResolver = typeof mod.resolveImportUrl === 'function' ? (mod.resolveImportUrl as (s: string) => string) : undefined;
    } catch {
      importResolver = undefined;
    }
  }
  return importResolver;
}

/**
 * The `import` half, SYNCHRONOUSLY, when the runtime allows it.
 *
 * Resolve the specifier under the `import` condition, then `require()` the file
 * it names. `require(esm)` and the application's own `import` share one module
 * map, keyed by URL, so this yields the very `Client` class object the
 * application will import — patched before the application's first line runs.
 *
 * It used to be enough to start an `import()` here and let it settle. Node 24
 * starts evaluating an ESM entry point before a `--require` preload's pending
 * `import()` settles, so an application calling a tool in its module body, or
 * in anything that body imports, called an unpatched class. Nothing failed and
 * nothing was said. Node 20.19+ and 22.12+ have `require(esm)`, which is
 * synchronous and so takes the race away. On older lines it throws, and the
 * `import()` pass remains the only way in.
 */
function patchImportHalfSync(
  id: string,
  pick: (m: Record<string, unknown>) => unknown,
  options: InstrumentMcpClientOptions
): HalfState {
  const resolveImportUrl = resolveImportUrlSync();
  if (resolveImportUrl === undefined) {
    return { status: 'deferred', cause: new Error('this Node cannot load an ES module synchronously') };
  }
  let url: string;
  try {
    url = resolveImportUrl(id);
  } catch (err) {
    if (NOT_INSTALLED.has(codeOf(err) ?? '')) return { status: 'absent' };
    return { status: 'failed', cause: err };
  }
  if (!url.startsWith('file:')) return { status: 'deferred', cause: new Error(`${url} is not a file`) };
  let mod: Record<string, unknown>;
  try {
    mod = withoutRequireEsmNotice(() => requireModule(fileURLToPath(url)));
  } catch (err) {
    if (NOT_SYNCHRONOUSLY_LOADABLE.has(codeOf(err) ?? '')) return { status: 'deferred', cause: err };
    return { status: 'failed', cause: err };
  }
  return patchLoaded(mod, pick, options);
}

/** The `import` half, asynchronously: for what the synchronous pass had to defer. */
async function patchImportHalfAsync(
  id: string,
  pick: (m: Record<string, unknown>) => unknown,
  options: InstrumentMcpClientOptions,
  deferredBecause: unknown
): Promise<HalfState> {
  if (dynamicImport === undefined) {
    // Code generation is disabled AND there is no `require(esm)`: the ESM build
    // cannot be reached at all. Say so rather than assume nobody imports it.
    return { status: 'failed', cause: deferredBecause };
  }
  let mod: Record<string, unknown>;
  try {
    mod = await dynamicImport(id);
  } catch (err) {
    if (NOT_INSTALLED.has(codeOf(err) ?? '')) return { status: 'absent' };
    return { status: 'failed', cause: err };
  }
  return patchLoaded(mod, pick, options);
}

/**
 * Report every half that is installed and still unpatched, on the SDK's one-time
 * capture warning. An application whose MCP client was not patched otherwise
 * sees nothing at all: no error, no record, and a collector that looks exactly
 * like an agent making no calls.
 */
function reportFailures(states: Map<string, CandidateState>): void {
  for (const [id, state] of states) {
    for (const half of ['import', 'require'] as const) {
      const s = state[half];
      if (s.status === 'failed') {
        const build = half === 'import' ? 'ESM' : 'CommonJS';
        warnCaptureFailed(s.cause, `MCP auto-instrumentation of the ${build} build of ${id}`);
      }
    }
  }
}

function patchedIds(states: Map<string, CandidateState>): string[] {
  return [...states]
    .filter(([, s]) => s.require.status === 'patched' || s.import.status === 'patched')
    .map(([id]) => id);
}

function detectSync(options: InstrumentMcpClientOptions): Map<string, CandidateState> {
  const states = new Map<string, CandidateState>();
  for (const { id, pick } of CANDIDATES) {
    states.set(id, {
      require: patchRequireHalf(id, pick, options),
      import: patchImportHalfSync(id, pick, options)
    });
  }
  return states;
}

/**
 * The SYNCHRONOUS half of the detection: patch every half of every optional
 * peer that can be loaded synchronously, before this function returns.
 *
 * It has to be synchronous, and it has to run in the preload. An application
 * can load its MCP client and make its first call in the SAME synchronous turn
 * as its module body — CommonJS always could, and on Node 24 an ESM entry point
 * does too, before any `import()` started in the preload has settled. Patching
 * on that later tick would miss exactly those calls, and miss them silently.
 *
 * Returns the module ids patched; a missing package is skipped, never an error.
 * An installed half that could not be patched is reported on the one-time
 * capture warning.
 */
export function patchInstalledMcpClientsSync(options: InstrumentMcpClientOptions = {}): string[] {
  const states = detectSync(options);
  reportFailures(new Map([...states].map(([id, s]) => [id, { ...s, import: settledOnly(s.import) }])));
  return patchedIds(states);
}

/** A deferred half is not a failure yet: the asynchronous pass may still patch it. */
function settledOnly(state: HalfState): HalfState {
  return state.status === 'deferred' ? { status: 'absent' } : state;
}

/**
 * A REAL dynamic `import()`, preserved through the CommonJS downlevel.
 *
 * This package compiles to CommonJS, and `tsc` rewrites a literal `import()` in
 * CJS output into `require()`. That is not an equivalent load: both MCP client
 * packages are **dual**, so `require()` resolves the `require` condition and
 * hands back a DIFFERENT `Client` class object from the one an ESM application
 * holds — and patching one leaves the other untouched. An agent written in ESM
 * (most of them) would then be captured by nothing at all, silently. The
 * `Function` indirection is invisible to the compiler, so the output keeps a
 * real `import()`.
 */
const dynamicImport: ((id: string) => Promise<Record<string, unknown>>) | undefined = (() => {
  try {
    return new Function('id', 'return import(id);') as (id: string) => Promise<Record<string, unknown>>;
  } catch {
    return undefined; // a runtime with code generation disabled — the `require` half still works
  }
})();

/** `require`, reached without the compiler rewriting our own imports into it. */
function requireModule(id: string): Record<string, unknown> {
  return require(id) as Record<string, unknown>;
}

/**
 * Run a synchronous load without the notice Node 22.12 and 23.0–23.4 print the
 * first time a CommonJS module `require()`s an ES module.
 *
 * Those lines flagged `require(esm)` as experimental on stderr. Here it would
 * name this SDK's own internals in an application's output, for a load the
 * application never asked for. Only that one notice is dropped, and only for
 * the duration of `load`. Node prints the notice once per process, so on those
 * two lines an application's own later `require(esm)` is not flagged either.
 * Newer lines print nothing, and there this wrapper filters nothing.
 */
function withoutRequireEsmNotice<T>(load: () => T): T {
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const text = typeof warning === 'string' ? warning : warning.message;
    const type =
      typeof rest[0] === 'string'
        ? rest[0]
        : ((rest[0] as { type?: unknown } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined));
    if (type === 'ExperimentalWarning' && /is loading ES Module [\s\S]* using require\(\)/.test(text)) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    return load();
  } finally {
    process.emitWarning = original;
  }
}

/**
 * Feature-detect the optional MCP client packages and auto-patch whichever is
 * present: `@modelcontextprotocol/sdk` (1.x Client) and/or
 * `@modelcontextprotocol/client` (2.x). Both are OPTIONAL peers — a missing
 * package is silently skipped, never an error. Returns the module ids patched.
 *
 * Each id is patched in BOTH halves, because in a dual package they are separate
 * class objects, and whichever half the application holds is the one that has to
 * be patched; patching both is the only way to be right without knowing how the
 * application was written. Both halves are patched synchronously where the
 * runtime allows ({@link patchInstalledMcpClientsSync}); an `import` half it had
 * to defer is patched here with a real `import()`. Whatever is installed and
 * still unpatched at the end is reported on the one-time capture warning.
 */
export async function registerMcpAutoInstrumentation(options: InstrumentMcpClientOptions = {}): Promise<string[]> {
  const states = detectSync(options);
  for (const { id, pick } of CANDIDATES) {
    const state = states.get(id)!;
    if (state.import.status === 'deferred') {
      state.import = await patchImportHalfAsync(id, pick, options, state.import.cause);
    }
  }
  reportFailures(states);
  return patchedIds(states);
}

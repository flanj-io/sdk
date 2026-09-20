import { instrumentMcpClient, type InstrumentMcpClientOptions, type McpClientLike } from './instrument-mcp-client';

const CTOR_PATCHED = Symbol.for('flanj.mcp.ctorPatched');

/**
 * Patch a Client CONSTRUCTOR so every instance self-instruments on first use
 * (the auto-patch path). The prototype's `callTool` /
 * `listTools` are shadowed by trampolines that, once per instance, pin the
 * ORIGINAL prototype methods onto the instance and run
 * {@link instrumentMcpClient} over them — after which the instance behaves
 * exactly like an explicitly wrapped client. Returns false (and changes
 * nothing) when the value is not a Client-shaped constructor.
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
 * The SYNCHRONOUS half of the detection: `require` each optional peer and patch
 * what it yields, before this function returns.
 *
 * It has to be synchronous, and it has to run in the preload. A CommonJS
 * application can `require` its MCP client and make its first call in the SAME
 * synchronous turn as its module body — which is still before any `import()`
 * started in the preload has settled. Patching on that later tick would miss
 * exactly those calls, and miss them silently.
 *
 * Returns the module ids patched; a missing package is skipped, never an error.
 */
export function patchInstalledMcpClientsSync(options: InstrumentMcpClientOptions = {}): string[] {
  const patched: string[] = [];
  for (const { id, pick } of CANDIDATES) {
    try {
      const moduleId: string = id; // variable indirection: no compile-time dependency
      if (patchMcpClientConstructor(pick(requireModule(moduleId)), options)) patched.push(id);
    } catch {
      /* optional peer not installed, or ESM-only on a runtime without require(esm) */
    }
  }
  return patched;
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
 * Feature-detect the optional MCP client packages and auto-patch whichever is
 * present: `@modelcontextprotocol/sdk` (1.x Client) and/or
 * `@modelcontextprotocol/client` (2.x). Both are OPTIONAL peers — a missing
 * package is silently skipped, never an error. Returns the module ids patched.
 *
 * Each id is loaded BOTH ways: synchronously with `require`
 * ({@link patchInstalledMcpClientsSync}) and then with a real `import()`. In a
 * dual package those are separate class objects, and whichever half the
 * application holds is the one that has to be patched; patching both is the only
 * way to be right without knowing how the application was written.
 */
export async function registerMcpAutoInstrumentation(options: InstrumentMcpClientOptions = {}): Promise<string[]> {
  const patched = new Set<string>(patchInstalledMcpClientsSync(options));
  if (dynamicImport === undefined) return [...patched];
  for (const { id, pick } of CANDIDATES) {
    try {
      const moduleId: string = id;
      // Already-patched constructors are re-detected here and no-op: the patch is
      // idempotent, so only a DIFFERENT (ESM) class object is newly wrapped.
      if (patchMcpClientConstructor(pick(await dynamicImport(moduleId)), options)) patched.add(id);
    } catch {
      /* optional peer not installed, or not importable — skip */
    }
  }
  return [...patched];
}

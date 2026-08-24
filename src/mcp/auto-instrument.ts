import { instrumentMcpClient, type InstrumentMcpClientOptions, type McpClientLike } from './instrument-mcp-client';

const CTOR_PATCHED = Symbol.for('vinifera.mcp.ctorPatched');

/**
 * Patch a Client CONSTRUCTOR so every instance self-instruments on first use
 * (the auto-patch path of v0.5 spec §4.B). The prototype's `callTool` /
 * `listTools` are shadowed by trampolines that, once per instance, pin the
 * ORIGINAL prototype methods onto the instance and run
 * {@link instrumentMcpClient} over them — after which the instance behaves
 * exactly like an explicitly wrapped client. Returns false (and changes
 * nothing) when the value is not a Client-shaped constructor.
 */
export function patchMcpClientConstructor(ctor: unknown, options: InstrumentMcpClientOptions): boolean {
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

/**
 * Feature-detect the optional MCP client packages and auto-patch whichever is
 * present: `@modelcontextprotocol/sdk` (1.x Client) and/or
 * `@modelcontextprotocol/client` (2.x). Both are OPTIONAL peers — a missing
 * package is silently skipped, never an error. Returns the module ids patched.
 */
export async function registerMcpAutoInstrumentation(options: InstrumentMcpClientOptions): Promise<string[]> {
  const candidates: { id: string; pick: (m: Record<string, unknown>) => unknown }[] = [
    { id: '@modelcontextprotocol/sdk/client/index.js', pick: (m) => m.Client },
    { id: '@modelcontextprotocol/client', pick: (m) => m.Client ?? m.McpClient ?? m.default }
  ];
  const patched: string[] = [];
  for (const { id, pick } of candidates) {
    try {
      const moduleId: string = id; // variable indirection: no compile-time dependency
      const mod = (await import(moduleId)) as Record<string, unknown>;
      if (patchMcpClientConstructor(pick(mod), options)) patched.push(id);
    } catch {
      /* optional peer not installed — skip */
    }
  }
  return patched;
}

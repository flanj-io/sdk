import { redact } from '@flanj/redaction-patterns';

/** The byte cap on `flanj.mcp.server.command` (CONTRACTS §2). */
export const MAX_COMMAND_BYTES = 1024;
/** The last element when arguments were dropped to fit the cap: exactly U+2026. */
export const ELLIPSIS = '…';

const encoder = new TextEncoder();
const fits = (text: string): boolean => encoder.encode(text).length <= MAX_COMMAND_BYTES;

/**
 * `flanj.mcp.server.command`: how a stdio MCP server was launched, e.g.
 * `["npx","-y","@stripe/mcp@0.2.1"]`. Each element is floor-redacted on its own,
 * the array is compact JSON, and it is capped at {@link MAX_COMMAND_BYTES} UTF-8
 * bytes: elements are kept in order while the array plus a closing `"…"` fits,
 * the command is always kept, and when even `[command,"…"]` does not fit the
 * attribute is omitted. Specified to the byte in CONTRACTS §2 — the Python SDK
 * (`flanj/mcp/launch.py`) must produce the identical string.
 */
export function launchCommandAttribute(command: unknown, args: readonly unknown[] = []): string | undefined {
  if (typeof command !== 'string' || command.length === 0) return undefined;
  const elements = [redact(command), ...args.map((a) => redact(String(a)))];
  const full = JSON.stringify(elements);
  if (fits(full)) return full;
  const kept = [elements[0]!];
  for (const element of elements.slice(1)) {
    if (fits(JSON.stringify([...kept, element, ELLIPSIS]))) kept.push(element);
    else break;
  }
  const capped = JSON.stringify([...kept, ELLIPSIS]);
  return fits(capped) ? capped : undefined;
}

/**
 * The launch command of a stdio transport, read-only. Both package lines'
 * `StdioClientTransport` keep their constructor params as `_serverParams`
 * (`@modelcontextprotocol/sdk` 1.30.0 and `@modelcontextprotocol/client` 2.0.0);
 * only `command` and `args` are read — never `env` or `cwd`. Never throws.
 */
export function stdioLaunchCommand(transport: unknown): string | undefined {
  try {
    if (transport === null || typeof transport !== 'object') return undefined;
    const params = (transport as Record<string, unknown>)._serverParams;
    if (params === null || typeof params !== 'object') return undefined;
    const { command, args } = params as { command?: unknown; args?: unknown };
    return launchCommandAttribute(command, Array.isArray(args) ? args : []);
  } catch {
    return undefined;
  }
}

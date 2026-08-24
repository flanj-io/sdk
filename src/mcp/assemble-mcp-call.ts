import { assembleCapturedCall } from '../instrumentation/assemble-call';
import { CappedBuffer } from '../instrumentation/capped-buffer';
import { DEFAULT_BODY_CAP_BYTES } from '../instrumentation/config';
import type { McpCallMeta, McpCapturedCall, McpServerKind } from './mcp-types';

/** The direction-agnostic inputs for one completed MCP tool call. */
export interface AssembleMcpCallInput {
  integration: string;
  peerHost: string;
  edgeClass: 'external' | 'internal' | 'local-process';
  serverKind: McpServerKind;
  toolName: string;
  /** The `tools/call` arguments — becomes the (redacted) request body. */
  args: unknown;
  /**
   * The CallToolResult (or undefined when the call rejected). `structuredContent`
   * (if present) else the joined `content[]` text becomes the response body.
   */
  result: unknown;
  isError: boolean;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  sessionId?: string;
  clientRequestId?: string;
  durationMs: number;
  bodyCapBytes?: number;
}

/**
 * Redact at source and assemble one MCP tool call on the SAME RedactedCall
 * shape as HTTP, funnelled through the one shared assembler
 * ({@link assembleCapturedCall}) so every floor rule — cap, content-type gate,
 * internal-edge metadata-only, redaction-then-drop, captured-value props —
 * applies identically:
 *   method = "tools/call" · route/target = "/<tool.name>" ·
 *   url    = "mcp://<peer.host>/<tool.name>" · statusCode = 0 (none in MCP).
 * A stdio server (`local-process`) captures bodies like an external edge; only
 * a streamable-HTTP peer classified `internal` stays metadata-only.
 */
export function assembleMcpCall(input: AssembleMcpCallInput): McpCapturedCall {
  const cap = input.bodyCapBytes ?? DEFAULT_BODY_CAP_BYTES;

  const req = capSerialized(serializeArgs(input.args), cap);
  const res = responseBody(input.result, cap);

  const call = assembleCapturedCall({
    integration: input.integration,
    direction: 'client',
    peerHost: input.peerHost,
    edgeClass: input.edgeClass,
    captureBodies: input.edgeClass !== 'internal',
    method: 'tools/call',
    protocol: 'mcp:',
    host: input.peerHost,
    path: `/${input.toolName}`,
    statusCode: 0,
    reqContentType: 'application/json',
    resContentType: res.contentType,
    reqBodyRaw: req.text,
    reqBodyTruncated: req.truncated,
    resBodyRaw: res.text,
    resBodyTruncated: res.truncated,
    requestHeaders: {},
    responseHeaders: {},
    correlation: {},
    durationMs: input.durationMs
  });

  const mcp: McpCallMeta = {
    toolName: input.toolName,
    isError: input.isError,
    serverKind: input.serverKind
  };
  if (input.serverName !== undefined) mcp.serverName = input.serverName;
  if (input.serverVersion !== undefined) mcp.serverVersion = input.serverVersion;
  if (input.protocolVersion !== undefined) mcp.protocolVersion = input.protocolVersion;
  if (input.sessionId !== undefined) mcp.sessionId = input.sessionId;
  if (input.clientRequestId !== undefined) mcp.clientRequestId = input.clientRequestId;

  return { ...call, transport: 'mcp', mcp };
}

function serializeArgs(args: unknown): string {
  if (args === undefined) return '';
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return '';
  }
}

/**
 * Response body per spec §4.B: `structuredContent` when present (JSON), else the
 * `content[]` text items joined with newlines (text — the floor's text path
 * still parses-then-traverses it when it IS JSON, so a PAN nested in
 * stringified JSON is caught structurally, not by a regex).
 */
function responseBody(result: unknown, cap: number): { text: string; truncated: boolean; contentType?: string } {
  if (result === null || typeof result !== 'object') return { text: '', truncated: false };
  const r = result as Record<string, unknown>;
  if (r.structuredContent !== undefined) {
    return { ...capSerialized(serializeArgs(r.structuredContent), cap), contentType: 'application/json' };
  }
  if (Array.isArray(r.content)) {
    const texts: string[] = [];
    for (const item of r.content) {
      if (item !== null && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
        const t = (item as Record<string, unknown>).text;
        if (typeof t === 'string') texts.push(t);
      }
    }
    if (texts.length > 0) return { ...capSerialized(texts.join('\n'), cap), contentType: 'text/plain' };
  }
  return { text: '', truncated: false };
}

/** Apply the same byte cap the HTTP path applies to its raw buffers. */
function capSerialized(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length === 0) return { text, truncated: false };
  const buf = new CappedBuffer(cap);
  buf.append(text);
  return { text: buf.toString(), truncated: buf.truncated };
}

import { describe, it, expect } from 'vitest';
import { assembleMcpCall, type AssembleMcpCallInput } from './assemble-mcp-call';
import { buildMcpCallAttributes } from './mcp-record';

/**
 * Redaction-before-emit sentinels for the MCP bodies (the spec §4.B floor
 * cases, mirrored here at the assembler level on top of the shared
 * cross-language fixture battery): PAN in args, PAN nested in
 * structuredContent, PAN inside stringified JSON in content[] text, base64
 * body in args — plus the metadata-only rules for edge classes and the cap.
 */

const PAN = '4242424242424242';

const base = (over: Partial<AssembleMcpCallInput>): AssembleMcpCallInput => ({
  integration: 'acme-payments',
  peerHost: 'mcp.acme.test',
  edgeClass: 'external',
  serverKind: 'streamable-http',
  toolName: 'create_refund',
  args: undefined,
  result: undefined,
  isError: false,
  durationMs: 5,
  ...over
});

describe('assembleMcpCall — redact at source', () => {
  it('redacts a PAN in tool-call args (whole-value, captured props emitted)', () => {
    const call = assembleMcpCall(base({ args: { card_number: PAN, amount: 1200 } }));
    expect(call.requestBody).toBe('{"card_number":"⟦REDACTED:PAN⟧","amount":1200}');
    expect(call.redactionPatterns).toEqual(['PAN']);
    expect(call.redactionFields).toEqual([
      {
        part: 'request',
        path: '/card_number',
        pattern: 'PAN',
        props: {
          type: 'string',
          length: 16,
          containsLowerCase: false,
          containsUpperCase: false,
          containsDigits: true,
          containsASCIIControlChars: false,
          containsASCIIPrintableChars: true,
          containsASCIIExtendedChars: false
        }
      }
    ]);
  });

  it('redacts a PAN nested in structuredContent (response body, application/json)', () => {
    const call = assembleMcpCall(
      base({ result: { structuredContent: { customer: { card: { number: PAN } }, ok: true } } })
    );
    expect(call.responseBody).toBe('{"customer":{"card":{"number":"⟦REDACTED:PAN⟧"}},"ok":true}');
    expect(call.responseContentType).toBe('application/json');
    expect(call.redactionFields).toEqual([
      expect.objectContaining({ part: 'response', path: '/customer/card/number', pattern: 'PAN' })
    ]);
  });

  it('redacts a PAN inside JSON carried as content[] text (parse-then-traverse, not a regex pass)', () => {
    const call = assembleMcpCall(
      base({ result: { content: [{ type: 'text', text: `{"customer":"cus_44","card_number":"${PAN}"}` }] } })
    );
    // The text path parses the JSON and rewrites only the fired scalar; the
    // whole-value redaction still carries the original's captured props.
    expect(call.responseBody).toBe('{"customer":"cus_44","card_number":"⟦REDACTED:PAN⟧"}');
    expect(call.responseContentType).toBe('text/plain');
    expect(call.redactionFields).toEqual([expect.objectContaining({ part: 'response', path: '/card_number' })]);
  });

  it('redacts a base64-encoded body in args (decode-then-scan; the whole run becomes one token)', () => {
    const payload = Buffer.from(`{"card_number":"${PAN}","amount":1200}`, 'utf8').toString('base64');
    const call = assembleMcpCall(base({ args: { encoding: 'base64', payload } }));
    expect(call.requestBody).toBe('{"encoding":"base64","payload":"⟦REDACTED:PAN⟧"}');
    expect(call.redactionPatterns).toEqual(['PAN']);
  });

  it('no raw PAN survives anywhere in the emitted attributes', () => {
    const call = assembleMcpCall(
      base({
        args: { card_number: PAN },
        result: {
          content: [{ type: 'text', text: `pan ${PAN}` }],
          structuredContent: { card: PAN },
          isError: false
        }
      })
    );
    expect(JSON.stringify(buildMcpCallAttributes(call))).not.toContain(PAN);
    expect(JSON.stringify(call)).not.toContain(PAN);
  });
});

describe('assembleMcpCall — shapes and edges', () => {
  it('joins multiple content[] text items and ignores non-text items', () => {
    const call = assembleMcpCall(
      base({
        result: {
          content: [
            { type: 'text', text: 'line one' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'text', text: 'line two' }
          ]
        }
      })
    );
    expect(call.responseBody).toBe('line one\nline two');
  });

  it('prefers structuredContent over content[] text', () => {
    const call = assembleMcpCall(
      base({ result: { content: [{ type: 'text', text: 'prose' }], structuredContent: { a: 1 } } })
    );
    expect(call.responseBody).toBe('{"a":1}');
    expect(call.responseContentType).toBe('application/json');
  });

  it('an internal streamable-HTTP edge stays metadata-only (no bodies at all)', () => {
    const call = assembleMcpCall(
      base({ peerHost: 'mcp-gw.internal', edgeClass: 'internal', args: { card_number: PAN } })
    );
    expect(call.captureBodies).toBe(false);
    expect(call.requestBody).toBe('');
    expect(call.responseBody).toBe('');
  });

  it('a local-process (stdio) edge captures + redacts bodies like an external edge', () => {
    const call = assembleMcpCall(
      base({ peerHost: 'acme-local-mcp', edgeClass: 'local-process', serverKind: 'stdio', args: { card_number: PAN } })
    );
    expect(call.captureBodies).toBe(true);
    expect(call.requestBody).toBe('{"card_number":"⟦REDACTED:PAN⟧"}');
  });

  it('caps bodies at bodyCapBytes and flags truncation', () => {
    const call = assembleMcpCall(base({ args: { blob: 'x'.repeat(4096) }, bodyCapBytes: 64 }));
    expect(call.requestBodyTruncated).toBe(true);
    expect(Buffer.byteLength(call.requestBody, 'utf8')).toBeLessThanOrEqual(64 + '⟦REDACTED:PAN⟧'.length);
  });

  it('statusCode is 0 and the tool rides the method/route slots', () => {
    const call = assembleMcpCall(base({}));
    expect(call.statusCode).toBe(0);
    expect(call.method).toBe('tools/call');
    expect(call.route).toBe('/create_refund');
    expect(call.urlFull).toBe('mcp://mcp.acme.test/create_refund');
    expect(call.direction).toBe('client');
  });
});

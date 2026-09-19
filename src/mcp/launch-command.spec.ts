import { describe, it, expect } from 'vitest';
import { ELLIPSIS, MAX_COMMAND_BYTES, launchCommandAttribute, stdioLaunchCommand } from './launch-command';

/**
 * `flanj.mcp.server.command` is specified to the byte in CONTRACTS §2 because the
 * Python SDK must emit the identical string. These vectors are literals shared with
 * the Python suite (`tests/mcp/test_launch_command.py`); if one side changes, the
 * other must.
 */
const VECTORS: [string, string[], string][] = [
  ['npx', ['-y', '@stripe/mcp@0.2.1', '--tools=all'], '["npx","-y","@stripe/mcp@0.2.1","--tools=all"]'],
  ['uvx', ['mcp-server-fetch'], '["uvx","mcp-server-fetch"]'],
  ['node', [], '["node"]'],
  // A secret in an argument is floor-redacted on its own, before the array is built.
  ['npx', ['@stripe/mcp', '--api-key=sk_live_FAKEfixtureKEY0001'], '["npx","@stripe/mcp","--api-key=⟦REDACTED:TOKEN⟧"]'],
  // Non-ASCII is written raw.
  ['npx', ['café-mcp'], '["npx","café-mcp"]']
];

describe('launchCommandAttribute — the shared encoding', () => {
  it.each(VECTORS)('%s %j', (command, args, expected) => {
    expect(launchCommandAttribute(command, args)).toBe(expected);
  });

  it('drops trailing arguments past the cap, in order, and marks the drop', () => {
    const args = Array.from({ length: 60 }, (_, i) => `--flag-${String(i).padStart(3, '0')}=` + 'x'.repeat(40));
    const value = launchCommandAttribute('npx', args)!;
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(MAX_COMMAND_BYTES);
    const decoded = JSON.parse(value) as string[];
    expect(decoded[0]).toBe('npx');
    expect(decoded.at(-1)).toBe(ELLIPSIS);
    expect(decoded.slice(1, -1)).toEqual(args.slice(0, decoded.length - 2));
    // One more element would not have fit with the closing marker.
    const oneMore = JSON.stringify([...decoded.slice(0, -1), args[decoded.length - 2], ELLIPSIS]);
    expect(new TextEncoder().encode(oneMore).length).toBeGreaterThan(MAX_COMMAND_BYTES);
  });

  it('omits a command too long to carry rather than truncating it', () => {
    expect(launchCommandAttribute('x'.repeat(2000), ['a'])).toBeUndefined();
  });

  it('records nothing without a command', () => {
    expect(launchCommandAttribute('', ['a'])).toBeUndefined();
    expect(launchCommandAttribute(undefined, ['a'])).toBeUndefined();
  });
});

describe('stdioLaunchCommand — read off the transport', () => {
  it('reads command and args from `_serverParams`, never env or cwd', () => {
    const transport = {
      _serverParams: {
        command: 'npx',
        args: ['-y', '@acme/payments-mcp@3.2.0'],
        env: { ACME_KEY: 'sk_live_FAKEfixtureKEY0001' },
        cwd: '/srv/acme-secret-dir'
      }
    };
    const value = stdioLaunchCommand(transport)!;
    expect(value).toBe('["npx","-y","@acme/payments-mcp@3.2.0"]');
    expect(value).not.toContain('ACME_KEY');
    expect(value).not.toContain('acme-secret-dir');
  });

  it('never throws on a transport it cannot read', () => {
    const hostile = Object.defineProperty({}, '_serverParams', {
      get() {
        throw new Error('hostile getter');
      }
    });
    expect(stdioLaunchCommand(hostile)).toBeUndefined();
    expect(stdioLaunchCommand({ url: 'https://mcp.acme.test/mcp' })).toBeUndefined();
    expect(stdioLaunchCommand(null)).toBeUndefined();
  });
});

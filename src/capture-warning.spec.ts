import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SILENCE_ENV,
  captureFailureMessage,
  resetCaptureWarningsForTests,
  warnCaptureFailed,
  warnOnce
} from './capture-warning';

/**
 * Capture is fenced everywhere: a failure stops collection and never reaches the
 * application. The cost of that trade is silence — and a collector showing
 * nothing looks exactly like an application making no calls. One line, once, is
 * what makes the difference visible. The Python SDK has said the same sentence,
 * under the same variable, since it shipped; this is the other half of that pair.
 */

beforeEach(() => {
  resetCaptureWarningsForTests();
  delete process.env[SILENCE_ENV];
});

afterEach(() => {
  delete process.env[SILENCE_ENV];
});

describe('warnCaptureFailed', () => {
  it('names what failed, why, and that the application is unaffected', () => {
    const lines: string[] = [];
    warnCaptureFailed(new TypeError('x.y is not a function'), 'capturing an MCP tool call', (m) => lines.push(m));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '[flanj] capturing an MCP tool call failed and capture has stopped for it: ' +
        'TypeError: x.y is not a function. Your application is unaffected; this is the only warning. ' +
        'Set FLANJ_SILENCE_CAPTURE_WARNINGS=1 to silence it.'
    );
  });

  it('prints once, not per call — a failing capture path fails on every call', () => {
    const lines: string[] = [];
    const push = (m: string): number => lines.push(m);
    warnCaptureFailed(new Error('first'), 'capturing an MCP tool call', push);
    warnCaptureFailed(new Error('second'), 'capturing an MCP tool call', push);
    warnCaptureFailed(new Error('third'), 'recording an MCP contract snapshot', push);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('first');
  });

  it('is silenced by FLANJ_SILENCE_CAPTURE_WARNINGS, and silencing does not arm a later line', () => {
    const lines: string[] = [];
    const push = (m: string): number => lines.push(m);
    process.env[SILENCE_ENV] = '1';
    warnCaptureFailed(new Error('boom'), 'capturing an MCP tool call', push);
    delete process.env[SILENCE_ENV];
    warnCaptureFailed(new Error('boom again'), 'capturing an MCP tool call', push);

    expect(lines).toEqual([]);
  });

  it('describes a non-Error throw rather than printing [object Object]', () => {
    expect(captureFailureMessage('a string', 'capturing an MCP tool call')).toContain('string: a string');
  });
});

describe('warnOnce', () => {
  it('prints once per key, and honours the same silencing variable', () => {
    const lines: string[] = [];
    const push = (m: string): number => lines.push(m);
    warnOnce('a', 'first', push);
    warnOnce('a', 'again', push);
    warnOnce('b', 'second', push);
    expect(lines).toEqual(['first', 'second']);

    resetCaptureWarningsForTests();
    process.env[SILENCE_ENV] = '1';
    warnOnce('a', 'first', push);
    expect(lines).toEqual(['first', 'second']);
  });
});

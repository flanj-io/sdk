import { describe, expect, it } from 'vitest';
import {
  catalogCacheHints,
  resultTypeOf,
  serverInfoFromMeta,
  taskIdOf,
  traceContextFromMeta,
  RESULT_TYPE_INPUT_REQUIRED,
  SERVER_INFO_META_KEY
} from './result-meta';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

describe('serverInfoFromMeta', () => {
  it('reads name and version from the 2026-07-28 _meta key', () => {
    const info = serverInfoFromMeta({
      _meta: { [SERVER_INFO_META_KEY]: { name: 'acme-tools-mcp', version: '1.2.0' } }
    });
    expect(info).toEqual({ name: 'acme-tools-mcp', version: '1.2.0' });
  });

  it('carries protocolVersion when the server publishes one', () => {
    const info = serverInfoFromMeta({
      _meta: { [SERVER_INFO_META_KEY]: { name: 's', protocolVersion: '2026-07-28' } }
    });
    expect(info?.protocolVersion).toBe('2026-07-28');
  });

  // undefined, not {} — "said nothing" must be distinguishable from "said it has
  // no name", or a later result would erase identity an earlier one supplied.
  it.each([
    ['no _meta at all', { content: [] }],
    ['_meta without the key', { _meta: { traceparent: 'x' } }],
    ['the key holding a non-object', { _meta: { [SERVER_INFO_META_KEY]: 'acme' } }],
    ['the key holding only blanks', { _meta: { [SERVER_INFO_META_KEY]: { name: '', version: '' } } }],
    ['a non-object result', null]
  ])('returns undefined for %s', (_label, result) => {
    expect(serverInfoFromMeta(result)).toBeUndefined();
  });

  it('never throws on a hostile getter', () => {
    const hostile = {};
    Object.defineProperty(hostile, '_meta', {
      get() {
        throw new Error('boom');
      }
    });
    expect(() => serverInfoFromMeta(hostile)).not.toThrow();
    expect(serverInfoFromMeta(hostile)).toBeUndefined();
  });
});

describe('traceContextFromMeta', () => {
  it('lifts the trace and span id out of a well-formed traceparent', () => {
    const ctx = traceContextFromMeta({ _meta: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` } });
    expect(ctx).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  it('lower-cases an upper-case traceparent', () => {
    const ctx = traceContextFromMeta({
      _meta: { traceparent: `00-${TRACE_ID.toUpperCase()}-${SPAN_ID.toUpperCase()}-01` }
    });
    expect(ctx).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  // A wrong correlation key is worse than a missing one: it points a provider
  // at somebody else's request.
  it.each([
    ['too few segments', `00-${TRACE_ID}-${SPAN_ID}`],
    ['a short trace id', `00-abc-${SPAN_ID}-01`],
    ['a short span id', `00-${TRACE_ID}-abc-01`],
    ['non-hex characters', `00-${'z'.repeat(32)}-${SPAN_ID}-01`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${SPAN_ID}-01`],
    ['an all-zero span id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`]
  ])('yields nothing rather than a bogus id for %s', (_label, traceparent) => {
    expect(traceContextFromMeta({ _meta: { traceparent } })).toBeUndefined();
  });

  it('returns undefined when there is no traceparent', () => {
    expect(traceContextFromMeta({ _meta: {} })).toBeUndefined();
    expect(traceContextFromMeta({})).toBeUndefined();
  });
});

describe('resultTypeOf', () => {
  it('reads the top-level resultType verbatim', () => {
    expect(resultTypeOf({ resultType: 'complete' })).toBe('complete');
    expect(resultTypeOf({ resultType: RESULT_TYPE_INPUT_REQUIRED })).toBe('input_required');
  });

  it('passes an unknown value through rather than coercing it', () => {
    expect(resultTypeOf({ resultType: 'something_new' })).toBe('something_new');
  });

  // Absent must stay absent: reading it as `complete` would let an older
  // server's traffic claim a guarantee it never made.
  it('is undefined on a server that sends none', () => {
    expect(resultTypeOf({ content: [] })).toBeUndefined();
    expect(resultTypeOf(null)).toBeUndefined();
  });
});

describe('taskIdOf', () => {
  it('reads the task id off a Tasks handle result', () => {
    expect(taskIdOf({ task: { taskId: 'task_1', status: 'working' } })).toBe('task_1');
  });

  it('falls back to the related-task _meta key', () => {
    expect(taskIdOf({ _meta: { 'io.modelcontextprotocol/related-task': { taskId: 'task_2' } } })).toBe('task_2');
    expect(taskIdOf({ _meta: { 'io.modelcontextprotocol/related-task': 'task_3' } })).toBe('task_3');
  });

  it('is undefined for an ordinary payload result', () => {
    expect(taskIdOf({ content: [{ type: 'text', text: 'hi' }] })).toBeUndefined();
    expect(taskIdOf({ structuredContent: { amount: 1200 } })).toBeUndefined();
  });
});

describe('catalogCacheHints', () => {
  it('reads ttlMs and cacheScope off a tools/list result', () => {
    expect(catalogCacheHints({ tools: [], ttlMs: 60000, cacheScope: 'session' })).toEqual({
      ttlMs: 60000,
      cacheScope: 'session'
    });
  });

  it('accepts either one alone', () => {
    expect(catalogCacheHints({ ttlMs: 0 })).toEqual({ ttlMs: 0 });
    expect(catalogCacheHints({ cacheScope: 'global' })).toEqual({ cacheScope: 'global' });
  });

  it.each([
    ['no hints', { tools: [] }],
    ['a negative ttl', { ttlMs: -1 }],
    ['a non-numeric ttl', { ttlMs: '60000' }],
    ['a NaN ttl', { ttlMs: Number.NaN }]
  ])('returns undefined for %s', (_label, result) => {
    expect(catalogCacheHints(result)).toBeUndefined();
  });
});

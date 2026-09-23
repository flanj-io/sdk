import { describe, it, expect } from 'vitest';
import { correlationIds } from './correlation-ids';

const from =
  (headers: Record<string, string | number | string[]>) =>
  (name: string): string | number | string[] | undefined =>
    headers[name];

describe('correlationIds', () => {
  it('takes the response request id over the request one', () => {
    // Arrange
    const req = from({ 'x-request-id': 'req-1', 'x-correlation-id': 'req-c' });
    const res = from({ 'x-request-id': 'res-1', 'x-correlation-id': 'res-c' });

    // Act
    const ids = correlationIds(req, res);

    // Assert
    expect(ids.requestId).toBe('res-1');
  });

  it('walks x-request-id then x-correlation-id, response side first, then the request side', () => {
    expect(correlationIds(from({ 'x-request-id': 'r' }), from({ 'x-correlation-id': 'c' })).requestId).toBe('c');
    expect(correlationIds(from({ 'x-request-id': 'r', 'x-correlation-id': 'c' }), from({})).requestId).toBe('r');
    expect(correlationIds(from({ 'x-correlation-id': 'c' }), from({})).requestId).toBe('c');
    expect(correlationIds(from({}), from({})).requestId).toBeUndefined();
  });

  it('takes the request idempotency key over the response one', () => {
    expect(correlationIds(from({ 'idempotency-key': 'mine' }), from({ 'idempotency-key': 'echo' })).idempotencyKey).toBe(
      'mine'
    );
    expect(correlationIds(from({}), from({ 'idempotency-key': 'echo' })).idempotencyKey).toBe('echo');
  });

  it('reads only the request when there is no response side (ingress)', () => {
    const ids = correlationIds(from({ 'x-correlation-id': 'c', 'idempotency-key': 'k' }));
    expect(ids).toEqual({ requestId: 'c', idempotencyKey: 'k' });
  });

  it('joins a repeated header and stringifies a number', () => {
    const ids = correlationIds(from({ 'x-request-id': ['a', 'b'], 'idempotency-key': 42 }));
    expect(ids).toEqual({ requestId: 'a, b', idempotencyKey: '42' });
  });
});

import { headerValue } from './header-value';

/** Reads one header by its lowercase name. */
type HeaderLookup = (name: string) => string | number | readonly string[] | undefined;

/**
 * The correlation keys of one call, with the same precedence on every capture
 * path so a call keys the same way whichever path saw it:
 *
 * - `requestId` — `x-request-id`, then `x-correlation-id`; the RESPONSE's first,
 *   because a provider that assigns one echoes its own id there, and the
 *   caller's only when the response carries neither.
 * - `idempotencyKey` — the REQUEST's `idempotency-key` (the caller chose it),
 *   then the response's.
 *
 * The ingress path passes no `response`: the caller's headers are the keys.
 */
export function correlationIds(
  request: HeaderLookup,
  response?: HeaderLookup
): { requestId?: string; idempotencyKey?: string } {
  const res = (name: string): string | undefined => (response ? headerValue(response(name)) : undefined);
  const req = (name: string): string | undefined => headerValue(request(name));
  return {
    requestId: res('x-request-id') ?? res('x-correlation-id') ?? req('x-request-id') ?? req('x-correlation-id'),
    idempotencyKey: req('idempotency-key') ?? res('idempotency-key')
  };
}

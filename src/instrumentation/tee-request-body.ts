import type { CappedBuffer } from './capped-buffer';
import { teeReadablePush } from './tee-readable-push';

/** What to send in place of the original body, plus any read still in flight. */
export interface TeedRequestBody {
  /** The body to hand the next dispatcher: the original, or a transparent tee of it. */
  body: unknown;
  /** Settles once an asynchronous copy (a Blob's leading bytes) is in the buffer. */
  pending?: Promise<void>;
}

/**
 * Observe a dispatch request body into `buf` without consuming, delaying or
 * altering what goes on the socket.
 *
 * `fetch()` always hands its dispatcher an async generator — whatever the app
 * passed as `body` (string, Uint8Array, URLSearchParams, Blob, FormData,
 * ReadableStream) has already been serialized into one by then — so the async
 * iterable branch is the fetch path. The other branches cover callers that
 * dispatch through the global dispatcher directly (`undici.request()` and
 * friends) with the body shapes undici accepts:
 *
 * - **bytes and strings** (string, Buffer, Uint8Array, ArrayBuffer and views,
 *   URLSearchParams) — immutable once handed over; copied up to the cap.
 * - **an async iterable** — replaced by a generator that yields every chunk of
 *   the original, unchanged and in order, recording each on the way past. It is
 *   lazy (pulls only when undici pulls, so backpressure is undici's) and
 *   forwards `return()`, so an aborted send still closes the source.
 * - **a Node Readable** — its `push` is wrapped, the same tee the http path
 *   uses on `IncomingMessage`; undici's own stream handling is untouched.
 * - **a Blob** — immutable and re-readable, so its first `cap + 1` bytes are
 *   read on the side while undici sends the whole.
 * - **FormData** — multipart, which the content-type gate never keeps; not read.
 *
 * Nothing past the cap is retained: `CappedBuffer` drops it and flags truncation.
 */
export function teeRequestBody(body: unknown, buf: CappedBuffer, cap: number): TeedRequestBody {
  if (body === null || body === undefined) return { body };
  if (typeof body === 'string' || body instanceof Uint8Array) {
    buf.append(body);
    return { body };
  }
  if (body instanceof ArrayBuffer) {
    buf.append(Buffer.from(body));
    return { body };
  }
  if (ArrayBuffer.isView(body)) {
    buf.append(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    return { body };
  }
  if (body instanceof URLSearchParams) {
    buf.append(body.toString());
    return { body };
  }
  if (typeof body !== 'object') return { body };

  const candidate = body as Record<string | symbol, unknown>;
  if (candidate[Symbol.toStringTag] === 'FormData') return { body };
  if (isNodeReadable(candidate)) {
    teeReadablePush(candidate, buf);
    return { body };
  }
  if (isBlobLike(candidate)) {
    const blob = candidate as unknown as Blob;
    const pending = blob
      .slice(0, cap + 1)
      .arrayBuffer()
      .then((bytes) => buf.append(Buffer.from(bytes)))
      .catch(() => undefined);
    return { body, pending };
  }
  if (typeof candidate[Symbol.asyncIterator] === 'function') {
    return { body: teeAsyncIterable(body as AsyncIterable<unknown>, buf) };
  }
  // A sync iterable of chunks, or a shape this version does not know: sent as
  // is, not recorded.
  return { body };
}

async function* teeAsyncIterable(source: AsyncIterable<unknown>, buf: CappedBuffer): AsyncGenerator<unknown> {
  for await (const chunk of source) {
    try {
      buf.append(chunk);
    } catch {
      // A chunk we cannot copy costs the record, never the send.
    }
    yield chunk;
  }
}

function isNodeReadable(v: Record<string | symbol, unknown>): boolean {
  return typeof v.pipe === 'function' && typeof v.on === 'function' && typeof v.push === 'function';
}

function isBlobLike(v: Record<string | symbol, unknown>): boolean {
  return typeof v.arrayBuffer === 'function' && typeof v.slice === 'function' && typeof v.stream === 'function';
}

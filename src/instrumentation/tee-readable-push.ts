import type { CappedBuffer } from './capped-buffer';

type Push = (chunk: unknown, encoding?: BufferEncoding) => boolean;

/**
 * Copy every chunk a Node Readable is fed into `buf`, by wrapping the stream's
 * own `push` — the call its source makes for each chunk, before any consumer
 * sees it. Nothing is read from the stream, so a consumer using `for await`,
 * `pipe` or `on('data')` gets exactly what it would have; a passive flowing-mode
 * `on('data')` listener would instead switch the stream to flowing mode and
 * starve an app that reads it later.
 *
 * `onEnd` runs when the source pushes `null` (end of stream), before the push
 * is forwarded. A chunk the buffer cannot take costs the record, never the
 * stream.
 */
export function teeReadablePush(stream: object, buf: CappedBuffer, onEnd?: () => void): void {
  const target = stream as { push: Push };
  const original = target.push.bind(target);
  target.push = (chunk: unknown, encoding?: BufferEncoding): boolean => {
    try {
      if (chunk === null || chunk === undefined) onEnd?.();
      else buf.append(chunk, encoding);
    } catch {
      // never let the tee break the stream
    }
    return original(chunk, encoding);
  };
}

import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { CappedBuffer } from './capped-buffer';
import { teeReadablePush } from './tee-readable-push';

describe('teeReadablePush', () => {
  it('copies every pushed chunk while a for-await consumer still reads the whole stream', async () => {
    // Arrange
    const stream = new Readable({ read() {} });
    const buf = new CappedBuffer(1024);
    let ended = 0;
    teeReadablePush(stream, buf, () => ended++);

    // Act
    stream.push('hello ');
    stream.push(Buffer.from('world'));
    stream.push(null);
    const read: string[] = [];
    for await (const chunk of stream) read.push(String(chunk));

    // Assert
    expect(read.join('')).toBe('hello world');
    expect(buf.toString()).toBe('hello world');
    expect(ended).toBe(1);
  });

  it('runs onEnd before the end-of-stream push is forwarded', () => {
    const stream = new Readable({ read() {} });
    let endedWhenForwarded: boolean | undefined;
    let ended = false;
    const originalPush = stream.push.bind(stream);
    stream.push = (chunk: unknown, encoding?: BufferEncoding): boolean => {
      if (chunk === null) endedWhenForwarded = ended;
      return originalPush(chunk, encoding);
    };
    teeReadablePush(stream, new CappedBuffer(16), () => {
      ended = true;
    });

    stream.push(null);

    expect(endedWhenForwarded).toBe(true);
  });

  it('forwards the push and its return value even when the tee throws', () => {
    const stream = new Readable({ read() {}, highWaterMark: 1 });
    const buf = { append: () => { throw new Error('buffer bug'); } } as unknown as CappedBuffer;
    teeReadablePush(stream, buf, () => {
      throw new Error('onEnd bug');
    });

    expect(stream.push('xx')).toBe(false); // over the high-water mark: backpressure intact
    expect(() => stream.push(null)).not.toThrow();
    expect(stream.readableLength).toBe(2);
  });

  it('forwards with the stream as `this` when push is called detached', () => {
    const stream = new Readable({ read() {} });
    teeReadablePush(stream, new CappedBuffer(16));
    const detached = stream.push;

    detached('x');

    expect(stream.readableLength).toBe(1);
  });
});

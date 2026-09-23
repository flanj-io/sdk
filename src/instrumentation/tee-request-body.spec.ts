import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { CappedBuffer } from './capped-buffer';
import { teeRequestBody } from './tee-request-body';

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

describe('teeRequestBody', () => {
  it('copies strings and bytes without replacing the body', () => {
    for (const body of ['{"a":1}', Buffer.from('{"a":1}'), new TextEncoder().encode('{"a":1}')]) {
      const buf = new CappedBuffer(64);
      expect(teeRequestBody(body, buf, 64).body).toBe(body);
      expect(buf.toString()).toBe('{"a":1}');
    }
  });

  it('copies URLSearchParams as the form text undici sends', () => {
    const buf = new CappedBuffer(64);
    teeRequestBody(new URLSearchParams({ a: '1', b: 'x y' }), buf, 64);
    expect(buf.toString()).toBe('a=1&b=x+y');
  });

  it('tees an async iterable: the SAME chunks, in order, and nothing is pulled early', async () => {
    const chunks = [Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef')];
    let pulled = 0;
    const source = (async function* () {
      for (const c of chunks) {
        pulled += 1;
        yield c;
      }
    })();
    const buf = new CappedBuffer(64);
    const teed = teeRequestBody(source, buf, 64).body as AsyncIterable<unknown>;
    expect(teed).not.toBe(source);
    expect(pulled).toBe(0);
    const sent = await drain(teed);
    expect(sent).toEqual(chunks);
    expect(sent[0]).toBe(chunks[0]);
    expect(buf.toString()).toBe('abcdef');
  });

  it('forwards return() to the source when the sender stops early', async () => {
    let closed = false;
    const source = (async function* () {
      try {
        yield Buffer.from('a');
        yield Buffer.from('b');
      } finally {
        closed = true;
      }
    })();
    const teed = teeRequestBody(source, new CappedBuffer(64), 64).body as AsyncGenerator<unknown>;
    await teed.next();
    await teed.return(undefined);
    expect(closed).toBe(true);
  });

  it('never retains past the cap, and flags truncation, while every byte is still sent', async () => {
    const big = Buffer.alloc(100, 0x61);
    const buf = new CappedBuffer(10);
    const teed = teeRequestBody((async function* () { yield big; yield big; })(), buf, 10).body as AsyncIterable<Buffer>;
    const sent = (await drain(teed)) as Buffer[];
    expect(Buffer.concat(sent).length).toBe(200);
    expect(buf.toBuffer().length).toBe(10);
    expect(buf.truncated).toBe(true);
  });

  it('tees a Node Readable through push, leaving the stream itself in place', async () => {
    const stream = Readable.from([Buffer.from('he'), Buffer.from('llo')]);
    const buf = new CappedBuffer(64);
    expect(teeRequestBody(stream, buf, 64).body).toBe(stream);
    const read = Buffer.concat((await drain(stream)) as Buffer[]).toString();
    expect(read).toBe('hello');
    expect(buf.toString()).toBe('hello');
  });

  it('reads the leading bytes of a Blob on the side', async () => {
    const blob = new Blob(['{"email":"a@b.test"}'], { type: 'application/json' });
    const buf = new CappedBuffer(64);
    const teed = teeRequestBody(blob, buf, 64);
    expect(teed.body).toBe(blob);
    await teed.pending;
    expect(buf.toString()).toBe('{"email":"a@b.test"}');
  });

  it('leaves FormData untouched and unread (multipart is never captured)', () => {
    const form = new FormData();
    form.set('a', '1');
    const buf = new CappedBuffer(64);
    expect(teeRequestBody(form, buf, 64).body).toBe(form);
    expect(buf.toBuffer().length).toBe(0);
  });
});

/**
 * Accumulates stream chunks up to a hard byte cap. Bytes beyond the cap are
 * discarded (and the buffer is flagged `truncated`) so a hostile/huge body can
 * never blow memory or exceed the OTLP attribute budget. The retained bytes are
 * the ONLY copy kept; there is no separate uncapped raw buffer.
 */
export class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncatedFlag = false;

  constructor(private readonly cap: number) {}

  append(chunk: unknown, encoding?: BufferEncoding): void {
    if (chunk === null || chunk === undefined) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, encoding ?? 'utf8')
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : undefined;
    if (!buf) return;
    if (this.size >= this.cap) {
      this.truncatedFlag = true;
      return;
    }
    const remaining = this.cap - this.size;
    if (buf.length > remaining) {
      this.chunks.push(buf.subarray(0, remaining));
      this.size = this.cap;
      this.truncatedFlag = true;
    } else {
      this.chunks.push(buf);
      this.size += buf.length;
    }
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  /** Decode the retained bytes as UTF-8. Callers redact this immediately. */
  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

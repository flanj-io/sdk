import { brotliDecompressSync, constants, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

/** The outcome of decoding a captured (possibly content-encoded) body. */
export interface DecodedBody {
  /** UTF-8 text ready for the redactor. Empty when the payload could not be decoded. */
  text: string;
  /**
   * `false` when a `content-encoding` was present that we could not undo. The
   * caller must then keep NO body: storing the raw wire bytes would put an
   * unscanned payload in the record under a text content-type, and report it as
   * clean. An empty body plus the `content-encoding` header is the honest row.
   */
  decoded: boolean;
  /** True when the retained bytes, or the decoded output, were cut at the cap. */
  truncated: boolean;
}

type Decoder = (input: Buffer, maxOutputLength: number) => Buffer;

/**
 * `finishFlush` is deliberately the FLUSH variant everywhere: the bytes we hold
 * are capped, so a compressed stream is very often cut mid-member. The default
 * `Z_FINISH` rejects that outright (`Z_BUF_ERROR`); flushing returns the decoded
 * prefix, which is exactly the truncated-body semantics of the identity path.
 */
const DEFLATE_OPTS = { finishFlush: constants.Z_SYNC_FLUSH } as const;

const inflateEither: Decoder = (input, maxOutputLength) => {
  try {
    return inflateSync(input, { ...DEFLATE_OPTS, maxOutputLength });
  } catch (err) {
    // Servers that advertise `deflate` sometimes send a raw (headerless) stream.
    // An over-cap failure is NOT a wrong-format signal — let it propagate.
    if (isOverCap(err)) throw err;
    return inflateRawSync(input, { ...DEFLATE_OPTS, maxOutputLength });
  }
};

/** Content codings we can undo, all from node core `zlib`. */
const DECODERS: Readonly<Record<string, Decoder>> = {
  gzip: (input, maxOutputLength) => gunzipSync(input, { ...DEFLATE_OPTS, maxOutputLength }),
  'x-gzip': (input, maxOutputLength) => gunzipSync(input, { ...DEFLATE_OPTS, maxOutputLength }),
  deflate: inflateEither,
  'x-deflate': inflateEither,
  br: (input, maxOutputLength) =>
    brotliDecompressSync(input, { finishFlush: constants.BROTLI_OPERATION_FLUSH, maxOutputLength })
};

/**
 * Turn the retained (capped) wire bytes of one body into redactable UTF-8 text.
 *
 * `IncomingMessage`/`ServerResponse` never decompress — axios, got, node-fetch
 * and compression middleware do that in userland, above/below the bytes we tee.
 * So any provider honouring the default `Accept-Encoding` hands us gzip/br
 * bytes; decoding them here is what puts the payload in front of the redaction
 * floor at all. When the coding is one we cannot undo we return NO text
 * (`decoded: false`) rather than a mangled blob the redactor would scan and
 * pronounce clean.
 *
 * Output is hard-bounded by `cap`, so a compression bomb cannot expand past the
 * body cap — not even transiently, inside zlib.
 */
export function decodeBody(
  bytes: Buffer,
  contentEncoding: string | undefined,
  cap: number,
  inputTruncated: boolean
): DecodedBody {
  const coding = normalizeCoding(contentEncoding);
  if (coding === undefined) return { text: bytes.toString('utf8'), decoded: true, truncated: inputTruncated };

  const decoder = DECODERS[coding];
  if (!decoder) return { text: '', decoded: false, truncated: inputTruncated };
  if (bytes.length === 0) return { text: '', decoded: true, truncated: inputTruncated };

  const whole = tryDecode(decoder, bytes, cap);
  if (whole) return { text: whole.toString('utf8'), decoded: true, truncated: inputTruncated };

  // The payload inflates past the cap. Recover the largest prefix that fits, so
  // a compressed body degrades exactly like an over-cap identity one: truncated
  // evidence, redacted — not silence.
  const prefix = decodeLargestPrefix(decoder, bytes, cap);
  if (prefix) return { text: prefix.toString('utf8'), decoded: true, truncated: true };

  return { text: '', decoded: false, truncated: inputTruncated };
}

/**
 * The single content coding to undo, lowercased — or `undefined` for "no coding"
 * (absent, empty, or `identity`). A stacked chain (`gzip, br`) is returned
 * joined so it matches no decoder: we do not unwind chains, and saying so via
 * the honest-empty path beats guessing.
 */
function normalizeCoding(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const codings = value
    .toLowerCase()
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c !== 'identity');
  if (codings.length === 0) return undefined;
  return codings.join(',');
}

function tryDecode(decode: Decoder, input: Buffer, cap: number): Buffer | undefined {
  try {
    return decode(input, cap);
  } catch {
    return undefined;
  }
}

/**
 * Largest prefix of `input` whose decoded output still fits under `cap`. Output
 * size grows monotonically with input length, so a bounded binary search finds
 * it in ~log2(input.length) decodes — each one itself capped at `cap`.
 */
function decodeLargestPrefix(decode: Decoder, input: Buffer, cap: number): Buffer | undefined {
  let lo = 0;
  let hi = input.length - 1;
  let best: Buffer | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const out = tryDecode(decode, input.subarray(0, mid), cap);
    if (out) {
      best = out;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best && best.length > 0 ? best : undefined;
}

/** zlib's "output would exceed maxOutputLength" signal. */
function isOverCap(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ERR_BUFFER_TOO_LARGE';
}

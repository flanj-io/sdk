/**
 * Base64 decode-then-scan support (item 3 of the floor's owned responsibilities).
 *
 * Locates runs that LOOK like base64 (≥ MIN_RUN chars of one base64 alphabet, optional
 * `=` padding), decodes them, and hands back the decoded TEXT when — and only when — it
 * is valid, printable UTF-8. Binary blobs, hashes and ordinary long words decode to
 * non-text and are never scanned. The caller runs the recognizers over the decoded text
 * and, on a hit, redacts the WHOLE encoded run. Depth is 1 (no base64-in-base64).
 *
 * The shape rules and decode semantics are mirrored exactly by the Go collector: lenient
 * about missing padding and trailing bits, strict about the alphabet and `len % 4 == 1`.
 */
const MIN_RUN = 20;
const RUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;

export interface Base64Run {
  start: number;
  end: number;
  decoded: string;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decode one candidate run; `null` when it is not base64 text. */
export function decodeBase64Text(run: string): string | null {
  let body = run;
  while (body.endsWith('=')) body = body.slice(0, -1);
  if (body.length < MIN_RUN || body.length % 4 === 1) return null;
  const std = /[+/]/.test(body);
  const url = /[_-]/.test(body);
  if (std && url) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(body, url ? 'base64url' : 'base64');
  } catch {
    return null;
  }
  // Node silently drops invalid input; guard that the whole run was consumed.
  if (bytes.length !== Math.floor((body.length * 3) / 4)) return null;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return null;
    if (c === 0x7f) return null;
  }
  return text;
}

/** Every base64-text run in `text`, left to right, non-overlapping. */
export function findBase64Runs(text: string): Base64Run[] {
  const runs: Base64Run[] = [];
  const re = new RegExp(RUN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const decoded = decodeBase64Text(m[0]);
    if (decoded !== null) runs.push({ start: m.index, end: m.index + m[0].length, decoded });
  }
  return runs;
}

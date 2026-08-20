import { charAt, isDigitAt } from './chars';
import { encodeJsonString } from './json-string';
import { classifyIntegerDigits } from './numbers';
import type { Recognizer, ScanContext } from './recognizer';
import { redactScalar } from './scalar';
import { makeToken, type PatternId } from './tokens';

/**
 * The TEXT entry point's traversal: how a captured body STRING is redacted.
 *
 * Bodies arrive as strings (the SDK's capped buffer, the collector's OTLP attribute, the
 * control plane's reply box). Rather than parse → clone → re-serialize — which would
 * reorder keys / reformat numbers differently in JS and Go and destroy formatting — the
 * text path SCANS the text and rewrites ONLY the scalars that fired, in place:
 *
 *  - JSON (first non-space char `{` or `[`): a tolerant scanner walks the text tracking
 *    object/array nesting and the current key; every string literal is decoded, scanned
 *    (keys too, values with their key as context), and re-encoded canonically only if it
 *    changed; number literals are checked for CVV-under-key / PAN-as-number; anything the
 *    scanner does not understand (malformed or truncated bodies) is scanned as plain text
 *    as "residue" — so EVERY byte of the body is scanned by some path and truncation at
 *    the capture cap never hides a scalar.
 *  - form-urlencoded (`k=v&k=v`): each key and value is percent-decoded, scanned (values
 *    with their key as context, so `cvv=123` is contextual and `email=jane%40x.com` is
 *    seen as an address), and re-encoded minimally only if it changed.
 *  - anything else: one scalar.
 *
 * The Go collector implements the identical scanner, so the same body redacts to the same
 * bytes in both languages.
 */
export interface TextPathResult {
  text: string;
  fired: Set<PatternId>;
}

interface Frame {
  kind: 'obj' | 'arr';
  /** For objects: what the scanner expects next. */
  state: 'key' | 'colon' | 'value' | 'comma';
  /** The original (un-redacted) current key, once read. */
  key?: string;
}

const WS = new Set([' ', '\t', '\n', '\r']);
const STRUCTURAL = new Set(['"', '{', '}', '[', ']', ':', ',']);

export function redactTextPath(text: string, recognizers: readonly Recognizer[]): TextPathResult {
  const fired = new Set<PatternId>();
  if (text.length === 0) return { text, fired };
  let i = 0;
  while (i < text.length && WS.has(text.charAt(i))) i++;
  const first = charAt(text, i);
  if (first === '{' || first === '[') return { text: scanJson(text, recognizers, fired), fired };
  if (isFormBody(text)) return { text: scanForm(text, recognizers, fired), fired };
  return { text: scalar(text, {}, recognizers, fired), fired };
}

function scalar(s: string, ctx: ScanContext, recognizers: readonly Recognizer[], fired: Set<PatternId>): string {
  const r = redactScalar(s, ctx, recognizers);
  for (const id of r.fired) fired.add(id);
  return r.value;
}

// --- JSON ------------------------------------------------------------------------------

function scanJson(text: string, recognizers: readonly Recognizer[], fired: Set<PatternId>): string {
  const n = text.length;
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  const expectsValue = (): boolean => {
    const t = top();
    return t === undefined || t.kind === 'arr' || t.state === 'value';
  };
  const valueDone = (): void => {
    const t = top();
    if (t && t.kind === 'obj') t.state = 'comma';
  };

  let out = '';
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (WS.has(c)) {
      out += c;
      i++;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? { kind: 'obj', state: 'key' } : { kind: 'arr', state: 'value' });
      out += c;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      valueDone();
      out += c;
      i++;
      continue;
    }
    if (c === ':' || c === ',') {
      const t = top();
      if (t && t.kind === 'obj') t.state = c === ':' ? 'value' : 'key';
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      // Find the closing quote, honouring escapes.
      let j = i + 1;
      while (j < n) {
        const cj = text.charAt(j);
        if (cj === '\\') j += 2;
        else if (cj === '"') break;
        else j++;
      }
      if (j >= n) {
        // Unterminated (truncated body): scan the remainder as plain text.
        out += scalar(text.slice(i), {}, recognizers, fired);
        i = n;
        break;
      }
      const literal = text.slice(i, j + 1);
      let decoded: string;
      try {
        decoded = JSON.parse(literal) as string;
      } catch {
        out += scalar(literal, {}, recognizers, fired);
        i = j + 1;
        continue;
      }
      const t = top();
      const isKey = t !== undefined && t.kind === 'obj' && t.state === 'key';
      let ctx: ScanContext = {};
      if (isKey) {
        t.key = decoded;
        t.state = 'colon';
      } else {
        if (t && t.kind === 'obj' && t.key !== undefined) ctx = { key: t.key };
        valueDone();
      }
      const redacted = scalar(decoded, ctx, recognizers, fired);
      out += redacted === decoded ? literal : encodeJsonString(redacted);
      i = j + 1;
      continue;
    }
    if (expectsValue() && (c === '-' || isDigitAt(text, i))) {
      const lit = numberLiteralAt(text, i);
      if (lit !== null) {
        const t = top();
        const key = t && t.kind === 'obj' ? t.key : undefined;
        const id = isIntegerLiteral(lit) ? classifyIntegerDigits(lit.replace('-', ''), key) : null;
        if (id) {
          fired.add(id);
          out += encodeJsonString(makeToken(id));
        } else {
          out += lit;
        }
        valueDone();
        i += lit.length;
        continue;
      }
    }
    if (expectsValue()) {
      const lit = ['true', 'false', 'null'].find((w) => text.startsWith(w, i));
      if (lit) {
        out += lit;
        valueDone();
        i += lit.length;
        continue;
      }
    }
    // Residue: anything else, up to the next structural character — scanned as text.
    let j = i + 1;
    while (j < n && !STRUCTURAL.has(text.charAt(j))) j++;
    out += scalar(text.slice(i, j), {}, recognizers, fired);
    i = j;
  }
  return out;
}

const NUMBER_LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function numberLiteralAt(text: string, i: number): string | null {
  const re = new RegExp(NUMBER_LITERAL.source, 'y');
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m[0] : null;
}

function isIntegerLiteral(lit: string): boolean {
  return !/[.eE]/.test(lit);
}

// --- form-urlencoded -------------------------------------------------------------------

/**
 * `k=v&k=v…`: no whitespace at all (a real form body encodes spaces as `+`/`%20`), at
 * most one `=` per pair, no empty key, and not a lone `blob=` (a base64 value's padding).
 */
export function isFormBody(text: string): boolean {
  if (!text.includes('=') || /\s/.test(text)) return false;
  const pairs = text.split('&');
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === 0) return false;
    if (eq >= 0 && pair.indexOf('=', eq + 1) >= 0) return false;
    // A form key never contains a quote (a quoted JSON string body is not a form).
    if (pair.slice(0, eq < 0 ? pair.length : eq).includes('"')) return false;
  }
  if (pairs.length === 1 && pairs[0]!.endsWith('=')) return false;
  return true;
}

function scanForm(text: string, recognizers: readonly Recognizer[], fired: Set<PatternId>): string {
  const pairs = text.split('&');
  const out: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      const decoded = formDecode(pair);
      const red = scalar(decoded, {}, recognizers, fired);
      out.push(red === decoded ? pair : formEncode(red));
      continue;
    }
    const rawKey = pair.slice(0, eq);
    const rawVal = pair.slice(eq + 1);
    const key = formDecode(rawKey);
    const val = formDecode(rawVal);
    const redKey = scalar(key, {}, recognizers, fired);
    const redVal = scalar(val, { key }, recognizers, fired);
    out.push((redKey === key ? rawKey : formEncode(redKey)) + '=' + (redVal === val ? rawVal : formEncode(redVal)));
  }
  return out.join('&');
}

/** `+` → space, `%XX` → byte (UTF-8 decoded leniently); malformed escapes pass through. */
export function formDecode(s: string): string {
  if (!s.includes('%') && !s.includes('+')) return s;
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '+') {
      bytes.push(0x20);
    } else if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of utf8.encode(c)) bytes.push(b);
    }
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/**
 * Minimal re-encoding of a REWRITTEN form key/value: only the characters that would
 * break the `k=v&k=v` structure are escaped (`%`, `&`, `=`, `+`, CR, LF) and spaces
 * become `+`; everything else — including the token glyphs — is written raw.
 */
export function formEncode(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === ' ') out += '+';
    else if (c === '%') out += '%25';
    else if (c === '&') out += '%26';
    else if (c === '=') out += '%3D';
    else if (c === '+') out += '%2B';
    else if (c === '\r') out += '%0D';
    else if (c === '\n') out += '%0A';
    else out += c;
  }
  return out;
}

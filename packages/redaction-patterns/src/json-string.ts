/**
 * Canonical JSON string encoding for REWRITTEN scalars on the text path. Escapes only
 * what JSON requires (`"`, `\`, control chars < 0x20 — short forms for \b \f \n \r \t,
 * lowercase `\u00xx` otherwise); everything else, including the token glyphs ⟦ ⟧ and any
 * non-ASCII, is written raw. This is byte-identical to `JSON.stringify` for well-formed
 * text and is implemented identically in the Go collector, so a rewritten literal is the
 * same bytes in both languages. Untouched literals are never re-encoded at all.
 */
export function encodeJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c >= 0x20) out += s.charAt(i);
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else out += '\\u' + c.toString(16).padStart(4, '0');
  }
  return out + '"';
}

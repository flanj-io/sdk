import type { InstrumentationConfig } from '@opentelemetry/instrumentation';
import type { CapturedCall } from './captured-call';

/** Default body capture cap in bytes (contract key `body_cap_bytes`). */
export const DEFAULT_BODY_CAP_BYTES = 16384;

/**
 * Content-type prefixes eligible for body capture. Each entry is matched as a
 * prefix of the MEDIA TYPE alone — `type/subtype`, lowercased, parameters such
 * as `; charset=utf-8` stripped — so `text/` admits every `text/*` and
 * `application/json` admits `application/json; charset=utf-8`.
 *
 * A media type carrying an RFC 6839 structured suffix is ALSO matched by the
 * base type that suffix denotes: `application/problem+json` (RFC 7807, the
 * standard error payload), `application/vnd.api+json`, `application/hal+json`,
 * `application/ld+json`, `application/merge-patch+json`, … all capture because
 * `application/json` is listed. Anything else (binary, multipart file uploads,
 * octet-stream, …) captures NO body.
 */
export const DEFAULT_CAPTURE_CONTENT_TYPES: readonly string[] = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/'
];

/**
 * RFC 6839 structured-syntax suffixes and the base media type each denotes.
 * `<type>/<subtype>+json` carries JSON, so it is gated exactly like
 * `application/json`. Extend this when the default list grows — `xml:
 * 'application/xml'` would admit `application/soap+xml`, `image/svg+xml`, … —
 * until then a suffix absent here is matched by nothing but its own prefix.
 */
const STRUCTURED_SUFFIX_BASE: Readonly<Record<string, string>> = {
  json: 'application/json'
};

export interface HttpBodyCaptureConfig extends InstrumentationConfig {
  /** Integration id emitted as `flanj.integration`, e.g. `acme-payments`. */
  integration: string;
  /** Body capture cap in bytes. Default {@link DEFAULT_BODY_CAP_BYTES}. */
  bodyCapBytes?: number;
  /**
   * Content-type prefixes to capture, REPLACING (not extending) the default
   * list; the matching rules are those of {@link DEFAULT_CAPTURE_CONTENT_TYPES}.
   * Structured-suffix types follow their base: keep `application/json` in the
   * list to keep `application/problem+json` and friends, or name one such type
   * on its own (`application/vnd.api+json`) to capture only it.
   */
  captureContentTypes?: readonly string[];
  /** Header allowlist. Default from `@flanj/redaction-patterns`. */
  headerAllowlist?: readonly string[];
  /**
   * Full-URL ignore matchers. A request whose `${protocol}//${host}${path}`
   * matches is NOT captured. Strings match by substring; RegExps by `.test()`.
   * `start()` seeds this with the collector's own OTLP endpoint host so the SDK
   * never captures its own export POSTs (which would create an unbounded
   * capture→export→capture feedback loop against a co-located collector).
   */
  ignoreUrls?: readonly (string | RegExp)[];
  /**
   * INGRESS only: the reverse proxies / load balancers in front of this
   * service, as IPs or CIDR blocks (`10.0.0.0/8`, `fd00::/8`, `::1`). The
   * caller of an inbound request is its socket peer; `X-Forwarded-For` is
   * believed ONLY when that peer is in this set, and then the caller is the hop
   * our own proxy appended (the rightmost hop that is not itself a trusted
   * proxy) — never the leftmost, which the client chose. Default: none — the
   * header is ignored, because it is client-controlled and would let any caller
   * pick its own edge class (and so whether its bodies are captured). Left
   * unset behind a proxy, every inbound caller classifies internal.
   * List your PROXIES' addresses, not your whole network: every address in
   * this set is skipped when walking the chain, so a caller inside it can
   * still pick its own class. Prefer host entries (`10.0.0.5`, `fd00::5`)
   * over broad ranges. An entry that is not an IP or CIDR throws at
   * construction — before anything else in start() has taken effect.
   */
  trustedProxies?: readonly string[];
  /** Sink for each completed, redacted call. Wired to the OTLP logger by start(). */
  onCapture?: (call: CapturedCall) => void;
}

/** True when `fullUrl` matches any ignore matcher (substring for strings, test for RegExps). */
export function isIgnoredUrl(fullUrl: string, matchers: readonly (string | RegExp)[] | undefined): boolean {
  if (!matchers || matchers.length === 0) return false;
  return matchers.some((m) => (typeof m === 'string' ? fullUrl.includes(m) : m.test(fullUrl)));
}

/**
 * True when a content-type header value is eligible for body capture: its media
 * type — or, for an RFC 6839 `+suffix` type, the base type that suffix denotes —
 * starts with an allowed prefix. See {@link DEFAULT_CAPTURE_CONTENT_TYPES}.
 */
export function isCaptureableContentType(contentType: string | undefined, allowed: readonly string[]): boolean {
  const mediaType = parseMediaType(contentType);
  if (mediaType === undefined) return false;
  const base = structuredBaseOf(mediaType);
  return allowed.some((entry) => {
    const prefix = entry.trim().toLowerCase();
    if (prefix.length === 0) return false;
    return mediaType.startsWith(prefix) || (base !== undefined && base.startsWith(prefix));
  });
}

/**
 * The `type/subtype` of a content-type header value — lowercased, trimmed,
 * parameters dropped — or `undefined` when the header is absent or carries no
 * media type at all (`; charset=utf-8` alone).
 */
function parseMediaType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const semicolon = contentType.indexOf(';');
  const mediaType = (semicolon < 0 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase();
  return mediaType.length > 0 ? mediaType : undefined;
}

/**
 * The base media type an RFC 6839 structured suffix denotes
 * (`application/problem+json` → `application/json`), or `undefined` when the
 * subtype carries no suffix this gate knows. A subtype has at most one
 * structured suffix, always the last `+` segment (RFC 6838 §4.2.8).
 */
function structuredBaseOf(mediaType: string): string | undefined {
  const plus = mediaType.lastIndexOf('+');
  if (plus < 0) return undefined;
  return STRUCTURED_SUFFIX_BASE[mediaType.slice(plus + 1)];
}

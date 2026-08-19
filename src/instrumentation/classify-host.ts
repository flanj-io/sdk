/** SDK edge classification of a peer host (CONTRACTS §2 `vinifera.edge.class`). */
export type EdgeClass = 'external' | 'internal';

const INTERNAL_NAME_SUFFIXES: readonly string[] = ['.svc.cluster.local', '.internal', '.local'];

/**
 * Classify a peer host as `internal` or `external` per the heuristic shared,
 * BYTE-FOR-BYTE, by every Vinifera component (SDK egress/ingress + collector).
 *
 * A host is **internal** if it is:
 *   - RFC1918: `10/8`, `172.16-31/12`, `192.168/16`
 *   - loopback: `127/8`, `::1`, `localhost`; unspecified `::`
 *   - link-local: `169.254/16`, IPv6 `fe80::/10`
 *   - ULA IPv6: `fc00::/7` (first byte `fc`/`fd`)
 *   - a name ending `.svc.cluster.local` / `.internal` / `.local`
 *   - a single-label hostname (no dot)
 * Otherwise it is **external** (public IP or public DNS name).
 *
 * Accepts `host`, `host:port`, `[ipv6]`, or `[ipv6]:port`. The port is ignored.
 */
export function classifyHost(host: string): EdgeClass {
  const hostname = normalizeHostname(host);
  if (hostname === '') return 'internal';

  const isIPv6 = hostname.includes(':');
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

  if (isIPv6) return classifyIPv6(hostname);
  if (isIPv4) return classifyIPv4(hostname);
  return classifyName(hostname);
}

/** Strip brackets, an IPv6-mapped-IPv4 prefix, and a trailing `:port`; lowercase. */
function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h === '') return '';

  // [ipv6] or [ipv6]:port
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end !== -1) return unmapIPv4(h.slice(1, end));
    return unmapIPv4(h.slice(1));
  }

  const colons = (h.match(/:/g) ?? []).length;
  // Exactly one colon => host:port (IPv4 or name). More than one => bare IPv6.
  if (colons === 1) h = h.slice(0, h.indexOf(':'));

  return unmapIPv4(h);
}

/** `::ffff:127.0.0.1` (IPv4-mapped IPv6, common on dual-stack sockets) => `127.0.0.1`. */
function unmapIPv4(h: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  return m?.[1] ?? h;
}

function classifyIPv6(h: string): EdgeClass {
  if (h === '::1') return 'internal'; // loopback
  if (h === '::') return 'internal'; // unspecified
  if (/^f[cd]/.test(h)) return 'internal'; // ULA fc00::/7
  if (/^fe[89ab]/.test(h)) return 'internal'; // link-local fe80::/10 (matches the collector)
  return 'external';
}

function classifyIPv4(h: string): EdgeClass {
  const parts = h.split('.');
  const a = Number.parseInt(parts[0] ?? '', 10);
  const b = Number.parseInt(parts[1] ?? '', 10);
  if (a === 127) return 'internal'; // loopback 127/8
  if (a === 10) return 'internal'; // RFC1918 10/8
  if (a === 192 && b === 168) return 'internal'; // RFC1918 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return 'internal'; // RFC1918 172.16-31/12
  if (a === 169 && b === 254) return 'internal'; // link-local 169.254/16
  return 'external';
}

function classifyName(h: string): EdgeClass {
  if (h === 'localhost') return 'internal';
  if (INTERNAL_NAME_SUFFIXES.some((s) => h.endsWith(s))) return 'internal';
  if (!h.includes('.')) return 'internal'; // single-label hostname
  return 'external';
}

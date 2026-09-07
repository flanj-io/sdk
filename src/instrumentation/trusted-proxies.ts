import { BlockList, isIP } from 'node:net';

/**
 * The set of socket peers whose `X-Forwarded-For` the INGRESS path may believe:
 * the reverse proxies / load balancers that sit in front of this service.
 *
 * Entries are bare IPs (`10.0.0.5`, `::1`) or CIDR blocks (`10.0.0.0/8`,
 * `fd00::/8`). An entry that is neither THROWS — at `start()`, so a typo fails
 * the boot loudly instead of silently un-trusting the proxy and classifying
 * every inbound caller internal (metadata-only, drift detection blind).
 *
 * The empty set — the default — trusts nobody: the header is ignored and the
 * socket peer is the caller. `X-Forwarded-For` is client-controlled by
 * definition, so believing it from an arbitrary peer lets any caller choose its
 * own edge class (a private first hop ⇒ "internal" ⇒ no bodies captured; a
 * public one from inside ⇒ "external" ⇒ internal bodies stored).
 */
export class TrustedProxies {
  private readonly list: BlockList | undefined;
  /** Number of entries (0 ⇒ nothing is ever trusted). */
  readonly size: number;

  constructor(entries: readonly string[] | undefined = []) {
    const cleaned = entries.map((e) => e.trim()).filter((e) => e !== '');
    this.size = cleaned.length;
    if (cleaned.length === 0) {
      this.list = undefined;
      return;
    }
    const list = new BlockList();
    for (const entry of cleaned) addEntry(list, entry);
    this.list = list;
  }

  /**
   * True when `address` — a socket `remoteAddress` or one `X-Forwarded-For`
   * hop — is inside the set. Tolerates the shapes those carry in practice:
   * IPv4-mapped IPv6 (`::ffff:10.0.0.5`), a zone id (`fe80::1%eth0`), brackets
   * and a trailing port (`[::1]:4318`, `10.0.0.5:4318`). Anything that is not
   * an IP address (a hostname, `unknown`, garbage) is never trusted.
   */
  isTrusted(address: string | undefined): boolean {
    if (!this.list || !address) return false;
    const ip = normalizeIp(address);
    const family = isIP(ip);
    if (family === 4) return this.list.check(ip, 'ipv4');
    if (family === 6) return this.list.check(ip, 'ipv6');
    return false;
  }
}

function addEntry(list: BlockList, entry: string): void {
  const slash = entry.indexOf('/');
  const ip = normalizeIp(slash === -1 ? entry : entry.slice(0, slash));
  const family = isIP(ip);
  if (family === 0) throw new Error(`trustedProxies: "${entry}" is not an IP address or CIDR block`);
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (slash === -1) {
    list.addAddress(ip, type);
    return;
  }
  const prefixText = entry.slice(slash + 1);
  const prefix = /^\d{1,3}$/.test(prefixText) ? Number.parseInt(prefixText, 10) : Number.NaN;
  const maxPrefix = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`trustedProxies: "${entry}" has an invalid prefix length (0-${maxPrefix})`);
  }
  list.addSubnet(ip, prefix, type);
}

/** Strip brackets / a trailing port / a zone id; unmap `::ffff:a.b.c.d`; lowercase. */
function normalizeIp(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end === -1 ? h.slice(1) : h.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(h)) {
    h = h.slice(0, h.indexOf(':'));
  }
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  return mapped?.[1] ?? h;
}

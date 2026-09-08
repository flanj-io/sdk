import type { TrustedProxies } from './trusted-proxies';

export interface ResolveIngressPeerInput {
  /** `req.socket.remoteAddress` — the immediate peer, the only identity the transport vouches for. */
  socketAddress: string | undefined;
  /** `req.headers['x-forwarded-for']` as Node hands it over (duplicates already joined, or an array). */
  forwardedFor: string | string[] | undefined;
  /** The proxies whose forwarded header may be believed. Empty ⇒ never. */
  trustedProxies: TrustedProxies;
}

/**
 * The CALLER of an inbound request, for edge classification.
 *
 * The socket peer is the default. `X-Forwarded-For` is consulted only when
 * that peer is a configured trusted proxy — and then the caller is the hop
 * **our own proxy appended**: walking the chain from the RIGHT, skipping every
 * hop that is itself a trusted proxy (a multi-tier LB), the first untrusted hop.
 * Never the leftmost: that is whatever the client chose to send, so picking it
 * lets a caller pick its own edge class. If every hop is trusted the request
 * originated inside the proxy tier and the leftmost (its origin) is reported.
 *
 * Returns `''` when nothing is known (no socket address, an untrusted-peer
 * chain is ignored rather than partially believed).
 */
export function resolveIngressPeer(input: ResolveIngressPeerInput): string {
  const socket = input.socketAddress ?? '';
  if (!input.trustedProxies.isTrusted(socket)) return socket;

  const hops = splitForwardedFor(input.forwardedFor);
  if (hops.length === 0) return socket;

  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!input.trustedProxies.isTrusted(hop)) return hop;
  }
  return hops[0] as string;
}

/** Every hop of the chain, left to right, trimmed, empties dropped. */
function splitForwardedFor(xff: string | string[] | undefined): string[] {
  if (xff === undefined) return [];
  const joined = Array.isArray(xff) ? xff.join(',') : xff;
  return joined
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');
}

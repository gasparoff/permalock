import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Addresses a public scanner must never talk to: loopback, private networks,
// link-local (cloud metadata lives there), carrier NAT, multicast, reserved.
const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
])
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96], // NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
])
  blocked.addSubnet(net, bits, 'ipv6');

/** True for an IP address that is not on the public internet. */
export function privateAddress(address) {
  const family = isIP(address);
  if (!family) return true;
  if (family === 4) return blocked.check(address, 'ipv4');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? blocked.check(mapped[1], 'ipv4') : blocked.check(address, 'ipv6');
}

const seen = new Map();
const SEEN_MS = 60_000;

/**
 * True when the host is an internal address, or a name that resolves to one.
 * A name that does not resolve is not internal: the request fails on its own.
 */
export async function internalHost(hostname, lookup = dnsLookup) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) return privateAddress(host);
  const hit = seen.get(host);
  if (hit && Date.now() - hit.at < SEEN_MS) return hit.internal;
  let internal = false;
  try {
    const addresses = await lookup(host, { all: true });
    internal = addresses.some((a) => privateAddress(a.address));
  } catch {
    internal = false;
  }
  if (seen.size > 5000) seen.clear();
  seen.set(host, { at: Date.now(), internal });
  return internal;
}

/**
 * fetch for the public scanner: http(s) only, and never to an internal
 * address. The core follows redirects by hand, one request per hop, so every
 * hop of a redirect chain passes through here.
 */
export function guardedFetch(inner = fetch, lookup = dnsLookup) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Refused: ${url.protocol} is not a web address`);
    if (await internalHost(url.hostname, lookup)) throw new Error(`Refused: ${url.hostname} is not a public address`);
    return inner(input, init);
  };
}

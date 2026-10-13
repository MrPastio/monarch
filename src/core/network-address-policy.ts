import { isIP } from 'node:net';

/** One public-address policy for every fetch whose target web content can
 * choose. The same rules live in `oscar/backend/oscar_agent/network_policy.py`;
 * both are held to `tests/fixtures/network-address-policy.json`.
 *
 * IPv6 is public only inside global unicast (2000::/3); IPv4 carried inside
 * IPv6 (mapped, NAT64, 6to4) is judged as that IPv4 address. Addresses are
 * compared as numbers, so every textual form of the same address gets the
 * same verdict. */

type Range = readonly [base: bigint, prefix: number];

const BLOCKED_V4: readonly Range[] = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
].map(item => cidr(item, 32));

const IPV6_GLOBAL_UNICAST = cidr('2000::/3', 128);
const IPV4_MAPPED = cidr('::ffff:0:0/96', 128);
const NAT64_WELL_KNOWN = cidr('64:ff9b::/96', 128);
const SIX_TO_FOUR = cidr('2002::/16', 128);
const BLOCKED_V6: readonly Range[] = ['2001::/32', '2001:db8::/32', '2001:10::/28', '2001:20::/28']
  .map(item => cidr(item, 128));

export function isPublicNetworkAddress(value: string): boolean {
  const text = String(value ?? '').trim().replace(/^\[|\]$/g, '').split('%', 1)[0]!;
  const family = isIP(text);
  if (family === 4) return isPublicV4(parseV4(text)!);
  if (family !== 6) return false;
  const address = parseV6(text);
  if (address === null) return false;
  if (inRange(address, IPV4_MAPPED, 128) || inRange(address, NAT64_WELL_KNOWN, 128)) {
    return isPublicV4(address & 0xffffffffn);
  }
  if (inRange(address, SIX_TO_FOUR, 128)) return isPublicV4((address >> 80n) & 0xffffffffn);
  return inRange(address, IPV6_GLOBAL_UNICAST, 128) && !BLOCKED_V6.some(range => inRange(address, range, 128));
}

function isPublicV4(address: bigint): boolean {
  return !BLOCKED_V4.some(range => inRange(address, range, 32));
}

function inRange(address: bigint, [base, prefix]: Range, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return (address >> shift) === (base >> shift);
}

function cidr(value: string, bits: 32 | 128): Range {
  const [text, prefix] = value.split('/') as [string, string];
  const base = bits === 32 ? parseV4(text) : parseV6(text);
  if (base === null) throw new Error(`network-address-policy: invalid range ${value}`);
  return [base, Number(prefix)];
}

function parseV4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((sum, part) => (sum << 8n) + BigInt(Number(part)), 0n);
}

function parseV6(text: string): bigint | null {
  let source = text.toLowerCase();
  // A trailing dotted IPv4 part stands for the last two groups.
  const dotted = source.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = parseV4(dotted[2]!);
    if (v4 === null) return null;
    source = `${dotted[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((sum, group) => (sum << 16n) + BigInt(parseInt(group, 16)), 0n);
}

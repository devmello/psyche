import { isIP } from "node:net";

/**
 * Deterministic SSRF checks (security §7.2 item 3): which addresses and host names a fetch may
 * never reach. Every address a model-generated URL resolves to is checked here before connect.
 */

type Range = readonly [base: bigint, prefix: number];

function v4ToBigInt(address: string): bigint {
  const parts = address.split(".").map((p) => Number.parseInt(p, 10));
  let out = 0n;
  for (const p of parts) out = (out << 8n) | BigInt(p & 0xff);
  return out;
}

function v4(cidr: string): Range {
  const [addr = "", prefix = "32"] = cidr.split("/");
  return [v4ToBigInt(addr), Number.parseInt(prefix, 10)];
}

/** Expand an IPv6 literal (with optional embedded dotted IPv4 tail) to a 128-bit integer. */
function v6ToBigInt(address: string): bigint {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const n = v4ToBigInt(tail);
    const hi = Number((n >> 16n) & 0xffffn).toString(16);
    const lo = Number(n & 0xffffn).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const [head = "", rest] = text.split("::");
  const headParts = head === "" ? [] : head.split(":");
  const restParts = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - headParts.length - restParts.length;
  const groups =
    rest === undefined
      ? headParts
      : [...headParts, ...Array.from({ length: missing }, () => "0"), ...restParts];
  let out = 0n;
  for (const g of groups) out = (out << 16n) | BigInt(Number.parseInt(g || "0", 16) & 0xffff);
  return out;
}

function v6(cidr: string): Range {
  const [addr = "", prefix = "128"] = cidr.split("/");
  return [v6ToBigInt(addr), Number.parseInt(prefix, 10)];
}

function inRange(value: bigint, bits: number, [base, prefix]: Range): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}

/** IPv4 ranges that are never public unicast (RFC 6890 special-purpose registry and friends). */
const BLOCKED_V4: Range[] = [
  "0.0.0.0/8", // "this" network
  "10.0.0.0/8", // private
  "100.64.0.0/10", // CGNAT shared space
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, includes 169.254.169.254 cloud metadata
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.88.99.0/24", // 6to4 relay anycast
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, includes 255.255.255.255 broadcast
].map(v4);

const BLOCKED_V6: Range[] = [
  "::/128", // unspecified
  "::1/128", // loopback
  "100::/64", // discard-only
  "2001::/32", // Teredo (tunnels to arbitrary IPv4)
  "2001:db8::/32", // documentation
  "fc00::/7", // unique local
  "fe80::/10", // link-local
  "fec0::/10", // deprecated site-local
  "ff00::/8", // multicast
].map(v6);

/** IPv6 prefixes that embed an IPv4 address in their low 32 bits; the embedded one is checked. */
const EMBEDS_V4_LOW: Range[] = [
  "::ffff:0:0/96", // IPv4-mapped
  "::/96", // IPv4-compatible (deprecated)
  "64:ff9b::/96", // NAT64 well-known
  "64:ff9b:1::/48", // NAT64 local-use
  "::ffff:0:0:0/96", // SIIT IPv4-translated
].map(v6);
const SIX_TO_FOUR = v6("2002::/16");

export type AddressVerdict = { ok: true } | { ok: false; reason: string };

function checkV4(n: bigint): AddressVerdict {
  for (const r of BLOCKED_V4) {
    if (inRange(n, 32, r)) return { ok: false, reason: "private_or_reserved_ipv4" };
  }
  return { ok: true };
}

/** Is `address` (an IPv4 or IPv6 literal, no brackets) a public unicast address? */
export function checkAddress(address: string): AddressVerdict {
  const family = isIP(address);
  if (family === 4) return checkV4(v4ToBigInt(address));
  if (family !== 6) return { ok: false, reason: "not_an_ip_address" };
  const n = v6ToBigInt(address);
  for (const r of EMBEDS_V4_LOW) {
    if (inRange(n, 128, r)) {
      // `::/96` also covers `::` and `::1`, which the blocked list rejects below.
      if (n <= 1n) break;
      const verdict = checkV4(n & 0xffffffffn);
      return verdict.ok ? verdict : { ok: false, reason: "ipv4_embedded_in_ipv6" };
    }
  }
  if (inRange(n, 128, SIX_TO_FOUR)) {
    const verdict = checkV4((n >> 80n) & 0xffffffffn);
    if (!verdict.ok) return { ok: false, reason: "ipv4_embedded_in_ipv6" };
  }
  for (const r of BLOCKED_V6) {
    if (inRange(n, 128, r)) return { ok: false, reason: "private_or_reserved_ipv6" };
  }
  return { ok: true };
}

/** `URL.hostname` without IPv6 brackets or a trailing root dot, lower-cased. */
export function bareHostname(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".home.arpa", ".lan"];

/** Host names that always mean "this machine or its private network", whatever DNS says. */
export function isBlockedHostname(hostname: string): boolean {
  const h = bareHostname(hostname);
  if (h === "" || h === "localhost" || h === "localhost.localdomain") return true;
  if (h === "metadata.google.internal") return true;
  return BLOCKED_SUFFIXES.some((s) => h.endsWith(s));
}

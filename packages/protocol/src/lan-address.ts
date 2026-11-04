/**
 * Which hosts count as "this local network" (remote-gateway design §3.1, "LAN"). One definition,
 * shared by the Gateway (what it may listen on), the desktop client (what it may pin a
 * self-signed certificate for) and the pairing-link parser (what a `psyche-pair:v2` link may
 * name), so the three cannot drift apart. No dependency on Node: the web build uses it too.
 *
 * Allowed:
 * - a `.local` multicast-DNS name;
 * - a private IPv4 address (RFC 1918: 10/8, 172.16/12, 192.168/16);
 * - an IPv6 unique-local address (RFC 4193, `fc00::/7`).
 *
 * Refused, on purpose:
 * - global unicast IPv6 (`2000::/3`) and every public address;
 * - IPv6 link-local (`fe80::/10`) and IPv4 link-local (`169.254/16`). A link-local address means
 *   nothing without the interface it was learned on (a zone id, `fe80::1%en0`), and a zone id
 *   cannot be written in a URL, an `Origin`/`Host` header, a certificate name or a pairing link
 *   (the WHATWG URL parser rejects it). The same Host is still reachable by its `.local` name,
 *   which the operating system resolves with the right interface;
 * - loopback, unspecified, multicast, IPv4-mapped IPv6 (`::ffff:10.0.0.1`), carrier-grade NAT
 *   (`100.64/10`) and anything with a zone id.
 */

export type LanHostKind = "mdns" | "ipv4-private" | "ipv6-unique-local";

/** `a.b.c.d` with plain decimal octets (no leading zeros, no short forms), else null. */
export function parseIpv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** Eight 16-bit groups of an IPv6 literal without brackets or a zone id, else null. */
export function parseIpv6(text: string): number[] | null {
  if (text === "" || /[^0-9a-fA-F:.]/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (side: string): number[] | null => {
    if (side === "") return [];
    const out: number[] = [];
    const parts = side.split(":");
    for (const [i, part] of parts.entries()) {
      if (part.includes(".")) {
        // A dotted IPv4 tail is allowed only as the very last part.
        const v4 = i === parts.length - 1 ? parseIpv4(part) : null;
        if (v4 === null) return null;
        out.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
        out.push(Number.parseInt(part, 16));
      }
    }
    return out;
  };
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  // `::` stands for at least one group of zeros.
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

export function isPrivateIpv4(a: readonly number[]): boolean {
  const [x = 0, y = 0] = a;
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}

/** `fc00::/7`: the first seven bits are 1111110. */
export function isUniqueLocalIpv6(groups: readonly number[]): boolean {
  return ((groups[0] ?? 0) & 0xfe00) === 0xfc00;
}

const MDNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const MDNS_NAME = new RegExp(`^${MDNS_LABEL}(?:\\.${MDNS_LABEL})*\\.local$`);

/**
 * What kind of local-network host `host` is, or null. `host` is a URL hostname: an IPv6 literal
 * may carry its brackets. Case-insensitive. A zone id (`%`) always yields null.
 */
export function lanHostKind(host: string): LanHostKind | null {
  // One trailing dot is the same name (`studio-mac.local.`); it is dropped before classifying.
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "" || h.length > 253 || h.includes("%")) return null;
  const bracketed = h.startsWith("[") && h.endsWith("]");
  const bare = bracketed ? h.slice(1, -1) : h;
  if (bracketed || bare.includes(":")) {
    const groups = parseIpv6(bare);
    return groups !== null && isUniqueLocalIpv6(groups) ? "ipv6-unique-local" : null;
  }
  if (/^[0-9.]+$/.test(bare)) {
    const v4 = parseIpv4(bare);
    return v4 !== null && isPrivateIpv4(v4) ? "ipv4-private" : null;
  }
  return MDNS_NAME.test(bare) ? "mdns" : null;
}

/**
 * Whether the name is in the `.local` (multicast DNS) space at all, valid or not. A name that
 * ends in `.local` and is not a well-formed one (`lanHostKind` null) is refused outright by
 * callers: it must never fall through to the system's trust as if it were an ordinary host,
 * because nothing public can certify a `.local` name.
 */
export function isLocalSuffixHost(host: string): boolean {
  return host.trim().toLowerCase().replace(/\.$/, "").endsWith(".local");
}

export function isLanHostName(host: string): boolean {
  return lanHostKind(host) !== null;
}

import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";

/**
 * Egress policy pieces (feature K4, security §5.2): which addresses a sandbox may reach and
 * which hosts its allowlist names. Pure functions; the proxy applies them to every connection.
 */

/** Never reachable, allowlisted or not: the host itself, the cloud metadata service, the LAN's link layer. */
const NEVER = new BlockList();
// IPv4
NEVER.addSubnet("0.0.0.0", 8, "ipv4"); // "this network", incl. 0.0.0.0
NEVER.addSubnet("127.0.0.0", 8, "ipv4"); // loopback: the Gateway, the owner's dev servers
NEVER.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. 169.254.169.254 metadata
NEVER.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
NEVER.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, incl. broadcast
NEVER.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments (#283)
NEVER.addSubnet("192.0.2.0", 24, "ipv4"); // documentation
NEVER.addSubnet("198.51.100.0", 24, "ipv4"); // documentation
NEVER.addSubnet("203.0.113.0", 24, "ipv4"); // documentation
// IPv6
NEVER.addAddress("::", "ipv6");
NEVER.addAddress("::1", "ipv6");
NEVER.addSubnet("fe80::", 10, "ipv6"); // link-local
NEVER.addSubnet("ff00::", 8, "ipv6"); // multicast
NEVER.addAddress("fd00:ec2::254", "ipv6"); // AWS metadata over IPv6
NEVER.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local
NEVER.addSubnet("2001:db8::", 32, "ipv6"); // documentation

/** Reachable only through an allowlist entry that says `private` (a LAN package mirror). */
const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT, incl. Tailscale
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking, used by some VPNs
PRIVATE.addSubnet("fc00::", 7, "ipv6"); // unique local

/** 16 bytes of a valid IPv6 address (any textual form, incl. a trailing dotted quad). */
function ipv6Bytes(address: string): number[] | undefined {
  let a = address.toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  let tail: number[] = [];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted !== null) {
    tail = dotted.slice(1, 5).map(Number);
    if (tail.some((n) => n > 255)) return undefined;
    a = `${a.slice(0, dotted.index)}0:0`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return undefined;
  const words = (h: string | undefined) => (h === undefined || h === "" ? [] : h.split(":"));
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...rest];
  if (all.length !== 8 || all.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return undefined;
  const bytes = all.flatMap((w) => {
    const n = Number.parseInt(w, 16);
    return [n >> 8, n & 255];
  });
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

const startsWith = (bytes: number[], prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
const zeros = (n: number) => Array<number>(n).fill(0);
const dottedQuad = (b: number[]) => b.join(".");

/**
 * The IPv4 address an IPv6 address stands for, when it embeds one, or `"blocked"` for
 * translation ranges whose embedding is not fixed (#283, TM-20): IPv4-mapped (`::ffff:0:0/96`),
 * IPv4-translated (`::ffff:0:0:0/96`), IPv4-compatible (`::/96`), NAT64 well-known
 * (`64:ff9b::/96`) and 6to4 (`2002::/16`) are classified by their IPv4 address; local-use
 * NAT64 (`64:ff9b:1::/48`) and Teredo (`2001::/32`) are refused outright.
 */
function embedded(bytes: number[]): string | "blocked" | undefined {
  if (startsWith(bytes, [...zeros(10), 0xff, 0xff])) return dottedQuad(bytes.slice(12));
  if (startsWith(bytes, [...zeros(8), 0xff, 0xff, 0, 0])) return dottedQuad(bytes.slice(12));
  if (startsWith(bytes, zeros(12))) return dottedQuad(bytes.slice(12));
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, ...zeros(8)])) return dottedQuad(bytes.slice(12));
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 1])) return "blocked";
  if (startsWith(bytes, [0x20, 0x02])) return dottedQuad(bytes.slice(2, 6));
  if (startsWith(bytes, [0x20, 0x01, 0, 0])) return "blocked";
  return undefined;
}

export type AddressClass = "public" | "private" | "blocked";

/** Classifies a resolved address. Anything that is not a valid IP is `blocked`. */
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 0) return "blocked";
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    if (bytes === undefined) return "blocked";
    const inner = embedded(bytes);
    if (inner === "blocked") return "blocked";
    // `::` and `::1` embed 0.0.0.0 and 0.0.0.1, both in the blocked 0.0.0.0/8.
    if (inner !== undefined) return classifyAddress(inner);
  }
  const type = family === 4 ? "ipv4" : "ipv6";
  if (NEVER.check(address, type)) return "blocked";
  if (PRIVATE.check(address, type)) return "private";
  return "public";
}

/** One allowlist entry: `host`, `*.domain` (subdomains only), optional `:port`, optional private. */
export interface AllowEntry {
  /** Lowercase ASCII host or `*.` wildcard, or an IP literal. */
  host: string;
  /** Ports allowed; default 80 and 443. */
  ports: number[];
  /** May resolve to a private (LAN) address. Loopback, link-local and metadata stay blocked. */
  allowPrivate: boolean;
}

export const DEFAULT_PORTS: readonly number[] = [80, 443];

/** Canonical host: lowercase, IDNA ASCII, no trailing dot, IPv6 without brackets. `undefined` if invalid. */
export function canonicalHost(host: string): string | undefined {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "") return undefined;
  if (isIP(h) !== 0) return h;
  const ascii = domainToASCII(h);
  if (ascii === "" || !/^[a-z0-9.-]+$/.test(ascii) || ascii.split(".").some((l) => l === "")) {
    return undefined;
  }
  return ascii;
}

/**
 * Parses allowlist entries: `pypi.org`, `*.githubusercontent.com`, `registry.npmjs.org:443`,
 * `mirror.lan:8080 private`, `https://files.pythonhosted.org` (scheme and path are dropped).
 * Invalid entries are skipped; a bare `*` is never accepted.
 */
export function parseAllowlist(entries: readonly (string | Partial<AllowEntry>)[]): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const raw of entries) {
    if (typeof raw !== "string") {
      const host = raw.host === undefined ? undefined : wildcardHost(raw.host);
      if (host === undefined) continue;
      const ports = (raw.ports ?? DEFAULT_PORTS).filter(validPort);
      out.push({
        host,
        ports: ports.length > 0 ? ports : [...DEFAULT_PORTS],
        allowPrivate: raw.allowPrivate === true,
      });
      continue;
    }
    const parts = raw.trim().split(/\s+/);
    const [spec, flag] = parts;
    if (spec === undefined || spec === "" || parts.length > 2) continue;
    if (flag !== undefined && flag !== "private") continue;
    let hostPort = spec.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "");
    let port: number | undefined;
    const m = /^(.*?):(\d+)$/.exec(hostPort);
    if (m?.[1] !== undefined && m[2] !== undefined && !m[1].includes(":")) {
      hostPort = m[1];
      port = Number(m[2]);
    }
    const host = wildcardHost(hostPort);
    if (host === undefined || (port !== undefined && !validPort(port))) continue;
    out.push({
      host,
      ports: port === undefined ? [...DEFAULT_PORTS] : [port],
      allowPrivate: flag === "private",
    });
  }
  return out;
}

function validPort(p: number): boolean {
  return Number.isInteger(p) && p > 0 && p < 65_536;
}

function wildcardHost(host: string): string | undefined {
  if (host.startsWith("*.")) {
    const rest = canonicalHost(host.slice(2));
    // A wildcard over an IP or a bare TLD is meaningless or too wide.
    return rest === undefined || isIP(rest) !== 0 || !rest.includes(".") ? undefined : `*.${rest}`;
  }
  return canonicalHost(host);
}

/** The entry that admits `host:port`, if any. `host` must already be canonical. */
export function matchAllowlist(
  entries: readonly AllowEntry[],
  host: string,
  port: number,
): AllowEntry | undefined {
  return entries.find((e) => {
    if (!e.ports.includes(port)) return false;
    if (e.host.startsWith("*.")) return host.endsWith(e.host.slice(1)) && host !== e.host.slice(2);
    return e.host === host;
  });
}

/** `https://host` for 443, `http://host` for 80, else `https://host:port` (CONNECT) or `http://host:port`. */
export function originOf(host: string, port: number, tunnel: boolean): string {
  const h = isIP(host) === 6 ? `[${host}]` : host;
  if (port === 443) return `https://${h}`;
  if (port === 80) return `http://${h}`;
  return `${tunnel ? "https" : "http"}://${h}:${port}`;
}

/**
 * The SNI of a TLS ClientHello at the start of `buf`. `undefined` while incomplete, `null`
 * when the bytes are not a ClientHello or carry no server name.
 */
export function parseSni(buf: Buffer): string | null | undefined {
  if (buf.length < 5) return undefined;
  if (buf[0] !== 0x16) return null; // not a handshake record
  const recordLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLen) return undefined;
  let p = 5;
  const end = 5 + recordLen;
  if (buf[p] !== 0x01) return null; // not ClientHello
  p += 4; // type + 3-byte length
  p += 2 + 32; // version + random
  if (p >= end) return null;
  p += 1 + (buf[p] ?? 0); // session id
  if (p + 2 > end) return null;
  p += 2 + buf.readUInt16BE(p); // cipher suites
  if (p >= end) return null;
  p += 1 + (buf[p] ?? 0); // compression methods
  if (p + 2 > end) return null;
  const extEnd = p + 2 + buf.readUInt16BE(p);
  p += 2;
  while (p + 4 <= Math.min(extEnd, end)) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    p += 4;
    if (type === 0 && p + 5 <= end) {
      // server_name: list length, name type (0 = host_name), name length, name
      const nameType = buf[p + 2];
      const nameLen = buf.readUInt16BE(p + 3);
      if (nameType !== 0 || p + 5 + nameLen > end) return null;
      return buf
        .subarray(p + 5, p + 5 + nameLen)
        .toString("ascii")
        .toLowerCase();
    }
    p += len;
  }
  return null;
}

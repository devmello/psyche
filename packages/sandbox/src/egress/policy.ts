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
// IPv6
NEVER.addAddress("::", "ipv6");
NEVER.addAddress("::1", "ipv6");
NEVER.addSubnet("fe80::", 10, "ipv6"); // link-local
NEVER.addSubnet("ff00::", 8, "ipv6"); // multicast
NEVER.addAddress("fd00:ec2::254", "ipv6"); // AWS metadata over IPv6

/** Reachable only through an allowlist entry that says `private` (a LAN package mirror). */
const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT, incl. Tailscale
PRIVATE.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking, used by some VPNs
PRIVATE.addSubnet("fc00::", 7, "ipv6"); // unique local

export type AddressClass = "public" | "private" | "blocked";

/** Embedded IPv4 of IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) addresses. */
function embeddedV4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (m?.[1] !== undefined) return m[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return undefined;
}

/** Classifies a resolved address. Anything that is not a valid IP is `blocked`. */
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 0) return "blocked";
  if (family === 6) {
    const v4 = embeddedV4(address);
    if (v4 !== undefined) return classifyAddress(v4);
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

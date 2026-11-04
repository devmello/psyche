import { isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { isPrivateIpv4, isUniqueLocalIpv6, parseIpv4, parseIpv6 } from "@psyche/protocol";
import { isWildcardAddress } from "./settings.ts";

/**
 * One address the Gateway could listen on for the LAN: a private IPv4 address (RFC 1918) or an
 * IPv6 unique-local one (`fc00::/7`, RFC 4193). Never a global unicast IPv6 address and never a
 * link-local one (`fe80::/10`): see `packages/protocol/src/lan-address.ts` for why.
 */
export interface LanInterface {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  /**
   * The network this address is on (`192.168.1.0/24`, `fd12:3456:789a:1:0:0:0:0/64`): what an
   * owner's "yes" is bound to. An IPv6 address is identified by its prefix, not the address, so a
   * rotating privacy address on the same network does not look like a new network.
   */
  network: string;
  /** The primary Wi-Fi or Ethernet address, the default when the owner picks none. */
  isDefault: boolean;
}

export type InterfaceLister = () => Record<string, NetworkInterfaceInfo[] | undefined>;

/**
 * Tunnels, VPNs and VM or container bridges are never offered, not even to pick: a listener on
 * one of them would reach a tailnet, a VPN's far side or a guest, not "this network".
 */
const VIRTUAL =
  /^(lo|utun|ipsec|ppp|awdl|llw|bridge|gif|stf|ap\d|anpi|vmnet|vboxnet|docker|veth|br-|virbr|tun|tap|wg|tailscale|zt|vnic|vlan)/i;
const PREFERRED = /^(en\d+|eth\d+|wlan\d+|wlp|enp|eno|ens|wl)/i;

/** Only private IPv4 (RFC 1918): 10/8, 172.16/12, 192.168/16. Public, CGNAT and link-local are out. */
export function isPrivateLanAddress(a: string): boolean {
  const v4 = parseIpv4(a);
  return v4 !== null && isPrivateIpv4(v4);
}

/** IPv6 unique-local (`fc00::/7`) written plainly: no zone id, no brackets, not IPv4-mapped. */
export function isUniqueLocalAddress(a: string): boolean {
  const groups = parseIpv6(a);
  return groups !== null && isUniqueLocalIpv6(groups);
}

/** An address the LAN listener may ever be given: private IPv4 or IPv6 unique-local. */
export function isLanBindAddress(a: string): boolean {
  return isPrivateLanAddress(a) || isUniqueLocalAddress(a);
}

function bitsOf(groupsOrOctets: readonly number[]): number {
  return groupsOrOctets.reduce((n, m) => n + m.toString(2).replace(/0/g, "").length, 0);
}

function networkOf(address: string, netmask: string, family: "IPv4" | "IPv6"): string | null {
  if (family === "IPv4") {
    const ip = parseIpv4(address);
    const mask = parseIpv4(netmask);
    if (ip === null || mask === null) return null;
    return `${ip.map((o, i) => o & (mask[i] ?? 0)).join(".")}/${bitsOf(mask)}`;
  }
  const ip = parseIpv6(address);
  const mask = parseIpv6(netmask);
  if (ip === null || mask === null) return null;
  return `${ip.map((g, i) => (g & (mask[i] ?? 0)).toString(16)).join(":")}/${bitsOf(mask)}`;
}

function isUsable(name: string, info: NetworkInterfaceInfo): boolean {
  if (info.internal || VIRTUAL.test(name) || isWildcardAddress(info.address)) return false;
  if (info.family === "IPv4") return isPrivateLanAddress(info.address);
  // A scope id or a zone in the text means link-local: never a LAN address here.
  return (
    info.family === "IPv6" &&
    !info.address.includes("%") &&
    (info.scopeid ?? 0) === 0 &&
    isUniqueLocalAddress(info.address)
  );
}

/**
 * The interfaces the owner can choose from, the primary one flagged: private IPv4 and IPv6
 * unique-local addresses on a physical-looking interface only. The default prefers a Wi-Fi or
 * Ethernet name (en0, eth0…) and an IPv4 address over an IPv6 one.
 */
export function listLanInterfaces(lister: InterfaceLister = networkInterfaces): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, infos] of Object.entries(lister())) {
    for (const info of infos ?? []) {
      if (!isUsable(name, info)) continue;
      const family = info.family === "IPv6" ? "IPv6" : "IPv4";
      const network = networkOf(info.address, info.netmask, family);
      if (network === null) continue;
      out.push({ name, address: info.address.toLowerCase(), family, network, isDefault: false });
    }
  }
  out.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, "en", { numeric: true });
    if (byName !== 0) return byName;
    if (a.family !== b.family) return a.family === "IPv4" ? -1 : 1;
    return a.address.localeCompare(b.address, "en");
  });
  const pick =
    out.find((i) => i.family === "IPv4" && PREFERRED.test(i.name)) ??
    out.find((i) => i.family === "IPv4") ??
    out.find((i) => PREFERRED.test(i.name)) ??
    out[0];
  return out.map((i) => (i === pick ? { ...i, isDefault: true } : i));
}

/**
 * The addresses to bind for the owner's choice. An empty selection is the primary interface
 * only. A name or address that is not an interface of this machine is reported, never guessed
 * at, and nothing resolves to a wildcard or a loopback address.
 *
 * IPv6 is opt-in. A name (or the primary interface) yields its IPv4 addresses, and its IPv6
 * unique-local addresses only when `includeIpv6` is true. An address the owner typed in full
 * selects exactly that address, in either family. `available` only ever holds addresses
 * `listLanInterfaces` accepted, so a global or link-local address can never resolve.
 */
export function resolveLanBinds(
  selection: readonly string[],
  available: readonly LanInterface[],
  includeIpv6 = false,
): { binds: LanInterface[]; unknown: string[] } {
  const binds: LanInterface[] = [];
  const unknown: string[] = [];
  const add = (hit: LanInterface) => {
    if (!binds.includes(hit)) binds.push(hit);
  };
  if (selection.length === 0) {
    const primary = available.find((i) => i.isDefault);
    if (primary && (primary.family === "IPv4" || includeIpv6)) add(primary);
  }
  for (const wanted of selection) {
    const literal = isIP(wanted) !== 0;
    const hits = available.filter((i) =>
      literal ? i.address === wanted.toLowerCase() : i.name === wanted,
    );
    const usable = hits.filter((i) => literal || i.family === "IPv4" || includeIpv6);
    if (usable.length === 0) unknown.push(wanted);
    for (const hit of usable) add(hit);
  }
  if (includeIpv6) {
    // Dual stack: the chosen interface's unique-local addresses go with its IPv4 ones.
    const names = new Set(binds.map((b) => b.name));
    for (const i of available) if (i.family === "IPv6" && names.has(i.name)) add(i);
  }
  return { binds, unknown };
}

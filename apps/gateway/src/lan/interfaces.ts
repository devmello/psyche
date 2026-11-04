import { isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { isWildcardAddress } from "./settings.ts";

/** One address the Gateway could listen on for the LAN. IPv4 only: no scoped link-local v6. */
export interface LanInterface {
  name: string;
  address: string;
  /** The network this address is on (`192.168.1.0/24`): what an owner's "yes" is bound to. */
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
  const [x = 0, y = 0] = a.split(".").map(Number);
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}

function networkOf(address: string, netmask: string): string {
  const ip = address.split(".").map(Number);
  const mask = netmask.split(".").map(Number);
  const bits = mask.reduce((n, m) => n + m.toString(2).replace(/0/g, "").length, 0);
  return `${ip.map((o, i) => o & (mask[i] ?? 0)).join(".")}/${bits}`;
}

function isUsable(name: string, info: NetworkInterfaceInfo): boolean {
  if (info.internal || info.family !== "IPv4" || VIRTUAL.test(name)) return false;
  return isPrivateLanAddress(info.address) && !isWildcardAddress(info.address);
}

/**
 * The interfaces the owner can choose from, the primary one flagged: private IPv4 on a
 * physical-looking interface only. The default prefers Wi-Fi or Ethernet names (en0, eth0…).
 */
export function listLanInterfaces(lister: InterfaceLister = networkInterfaces): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, infos] of Object.entries(lister())) {
    for (const info of infos ?? []) {
      if (isUsable(name, info)) {
        out.push({
          name,
          address: info.address,
          network: networkOf(info.address, info.netmask),
          isDefault: false,
        });
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const pick = out.find((i) => PREFERRED.test(i.name)) ?? out[0];
  return out.map((i) => (i === pick ? { ...i, isDefault: true } : i));
}

/**
 * The addresses to bind for the owner's choice. An empty selection is the primary interface
 * only. A name or address that is not an interface of this machine is reported, never guessed
 * at, and nothing resolves to a wildcard or a loopback address.
 */
export function resolveLanBinds(
  selection: readonly string[],
  available: readonly LanInterface[],
): { binds: LanInterface[]; unknown: string[] } {
  if (selection.length === 0) {
    const primary = available.find((i) => i.isDefault);
    return { binds: primary ? [primary] : [], unknown: [] };
  }
  const binds: LanInterface[] = [];
  const unknown: string[] = [];
  for (const wanted of selection) {
    const hits = available.filter((i) => (isIP(wanted) ? i.address === wanted : i.name === wanted));
    if (hits.length === 0) unknown.push(wanted);
    for (const hit of hits) if (!binds.includes(hit)) binds.push(hit);
  }
  return { binds, unknown };
}

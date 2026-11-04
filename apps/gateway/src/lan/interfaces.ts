import { isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { isWildcardAddress } from "./settings.ts";

/** One address the Gateway could listen on for the LAN. IPv4 only: no scoped link-local v6. */
export interface LanInterface {
  name: string;
  address: string;
  /** The primary Wi-Fi or Ethernet address, the default when the owner picks none. */
  isDefault: boolean;
}

export type InterfaceLister = () => Record<string, NetworkInterfaceInfo[] | undefined>;

/** A virtual or tunnel interface is never the right default for "this network". */
const VIRTUAL =
  /^(lo|utun|awdl|llw|bridge|gif|stf|ap|anpi|vmnet|vboxnet|docker|veth|br-|virbr|tun|tap|wg|tailscale|zt)/i;
const PREFERRED = /^(en\d+|eth\d+|wlan\d+|wlp|enp|eno|ens|wl)/i;

function isUsable(info: NetworkInterfaceInfo): boolean {
  if (info.internal || info.family !== "IPv4") return false;
  const a = info.address;
  // Not loopback, not APIPA link-local (no network), not the wildcard, not multicast.
  if (a.startsWith("127.") || a.startsWith("169.254.") || isWildcardAddress(a)) return false;
  return Number(a.split(".")[0]) < 224;
}

/**
 * The interfaces the owner can choose from, the primary one flagged. The default is a
 * physical-looking Wi-Fi or Ethernet name first (en0, eth0, wlan0…), then any other non-virtual
 * interface; tunnels and VM bridges are listed but never the default.
 */
export function listLanInterfaces(lister: InterfaceLister = networkInterfaces): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, infos] of Object.entries(lister())) {
    for (const info of infos ?? []) {
      if (isUsable(info)) out.push({ name, address: info.address, isDefault: false });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const pick =
    out.find((i) => PREFERRED.test(i.name) && !VIRTUAL.test(i.name)) ??
    out.find((i) => !VIRTUAL.test(i.name));
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

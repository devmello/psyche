import Bonjour from "bonjour-service";

/**
 * Bonjour advertising of `_psyche._tcp` (remote-gateway design §3.2). The record is public to
 * everyone on the network, so it carries only what a picker needs to show: the host name (which
 * is also the SRV target and the instance name), the port (SRV) and the Gateway key fingerprint.
 * No secret, no token, no device or user name. It proves nothing: the fingerprint is a hint the
 * client checks against the key the Gateway then proves it holds.
 */
export const PSYCHE_SERVICE_TYPE = "psyche";
export const TXT_VERSION = "1";

export interface LanTxtInput {
  /** The host name label, no `.local`. */
  hostName: string;
  /** `sha256:<hex>` of the Gateway identity key (what the pairing card shows). */
  fingerprint: string;
}

/** The whole TXT record. Keys are fixed; adding one means reviewing it for secrets. */
export function buildLanTxt(input: LanTxtInput): Record<string, string> {
  return {
    v: TXT_VERSION,
    name: input.hostName,
    fp: input.fingerprint.replace(/^sha256:/, ""),
  };
}

export interface AdvertiseSpec {
  /** The instance name; equals the host label. */
  name: string;
  /** SRV target host, `<label>.local`; resolved by the operating system's own mDNS responder. */
  host: string;
  port: number;
  txt: Record<string, string>;
  /** Answer only on the interface with this address. */
  interfaceAddress: string;
}

export interface Advertisement {
  stop(): Promise<void>;
}

/** The mDNS backend; the Gateway injects a fake in tests so nothing touches the network. */
export interface MdnsAdvertiser {
  publish(spec: AdvertiseSpec): Advertisement;
}

/** The address records a service would announce: we announce none (see `bonjourAdvertiser`). */
export function withoutAddressRecords<T extends { type: string }>(records: T[]): T[] {
  return records.filter((r) => r.type !== "A" && r.type !== "AAAA");
}

/**
 * Options for the `multicast-dns` responder. `interface` alone would also make it bind port 5353
 * to that unicast address (it binds `opts.bind || opts.interface`), and a socket bound to a
 * unicast address never receives multicast queries on macOS. So it binds the wildcard to hear
 * them (a UDP socket on 5353 that only answers mDNS), while `interface` keeps the multicast
 * membership and the outgoing traffic on the chosen network.
 */
export function responderOptions(interfaceAddress: string): { bind: string; interface: string } {
  return { bind: "0.0.0.0", interface: interfaceAddress };
}

/**
 * The real backend (`bonjour-service` over `multicast-dns`). One responder per chosen interface,
 * bound to that interface's address. It publishes the PTR/SRV/TXT records only: the operating
 * system's own responder already answers `<host>.local` for this machine's addresses, and a
 * second responder claiming that name could make macOS rename the Mac to resolve a "conflict".
 */
export function bonjourAdvertiser(onError: (err: unknown) => void = () => {}): MdnsAdvertiser {
  return {
    publish(spec) {
      const bonjour = new Bonjour(responderOptions(spec.interfaceAddress) as never, onError);
      const service = bonjour.publish({
        name: spec.name,
        type: PSYCHE_SERVICE_TYPE,
        protocol: "tcp",
        port: spec.port,
        host: spec.host,
        txt: spec.txt,
        disableIPv6: true,
      });
      // `records()` is read when the announcement goes out (after the name probe) and again at
      // goodbye, so replacing it right after `publish` covers both.
      const records = service.records.bind(service);
      service.records = () => withoutAddressRecords(records());
      return {
        stop: () =>
          new Promise<void>((resolve) => {
            try {
              bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
            } catch {
              resolve();
            }
          }),
      };
    },
  };
}

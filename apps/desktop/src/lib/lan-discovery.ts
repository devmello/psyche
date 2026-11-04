import { createHash } from "node:crypto";
import Bonjour from "bonjour-service";
import { cleanGatewayName, normalizeGatewayOrigin } from "./gateways.ts";

/**
 * Finding Gateways on the local network (remote-gateway design §3.2): Bonjour `_psyche._tcp`.
 * Everything a neighbour announces is untrusted text. This keeps only a host label, a port and a
 * key fingerprint, each re-validated here, builds the origin itself (`https://<label>.local:<port>`)
 * and never uses an address from anywhere else. A listing proves nothing: picking one adds a saved
 * Gateway that still goes through the pairing and pin flow, and the fingerprint is only a hint the
 * first connect checks against the key the Gateway then proves it holds.
 */

export interface DiscoveredGateway {
  /** Stable for this origin; what the window sends back to add it. */
  id: string;
  name: string;
  origin: string;
  /** `sha256:<hex>` the Gateway announced for its identity key, or null. A claim, not a proof. */
  fingerprint: string | null;
}

/** What a Bonjour browser reports for one service. */
export interface FoundService {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  txt?: unknown;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A listing for one announced service, or null when anything about it is not plain. */
export function toDiscovered(svc: FoundService): DiscoveredGateway | null {
  if (typeof svc.host !== "string" || typeof svc.port !== "number") return null;
  if (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535) return null;
  const host = svc.host.trim().toLowerCase().replace(/\.$/, "");
  const label = host.endsWith(".local") ? host.slice(0, -".local".length) : null;
  if (label === null || !LABEL.test(label)) return null;
  const txt =
    typeof svc.txt === "object" && svc.txt !== null ? (svc.txt as Record<string, unknown>) : {};
  if (txt.v !== undefined && String(txt.v) !== "1") return null;
  let origin: string;
  try {
    origin = normalizeGatewayOrigin(`https://${label}.local:${svc.port}`);
  } catch {
    return null;
  }
  const announced = typeof txt.name === "string" ? cleanGatewayName(txt.name) : "";
  const fp = typeof txt.fp === "string" ? txt.fp.toLowerCase() : "";
  return {
    id: createHash("sha256").update(origin).digest("hex").slice(0, 16),
    name: announced === "" ? label : announced,
    origin,
    fingerprint: HEX64.test(fp) ? `sha256:${fp}` : null,
  };
}

/** Collects what `browse` reports for `timeoutMs`, validated and de-duplicated by origin. */
export type Browse = (onFound: (svc: FoundService) => void, timeoutMs: number) => Promise<void>;

export const bonjourBrowse: Browse = (onFound, timeoutMs) =>
  new Promise((resolve) => {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: "psyche", protocol: "tcp" }, (svc) =>
      onFound({ name: svc.name, host: svc.host, port: svc.port, txt: svc.txt }),
    );
    setTimeout(() => {
      try {
        browser.stop();
        bonjour.destroy();
      } catch {
        // nothing left to release
      }
      resolve();
    }, timeoutMs);
  });

/**
 * Browses on request (the owner clicks "Look on this network"), never in the background: it asks
 * the system's local-network permission only when the owner wants it, and keeps the last result
 * in memory so the window can only add a Gateway this process itself found.
 */
export class LanDiscovery {
  readonly #browse: Browse;
  #last = new Map<string, DiscoveredGateway>();

  constructor(browse: Browse = bonjourBrowse) {
    this.#browse = browse;
  }

  async discover(timeoutMs = 4_000): Promise<DiscoveredGateway[]> {
    const found = new Map<string, DiscoveredGateway>();
    await this.#browse((svc) => {
      const d = toDiscovered(svc);
      if (d !== null && found.size < 32) found.set(d.id, d);
    }, timeoutMs);
    this.#last = found;
    return [...found.values()];
  }

  /** A listing this process found; `undefined` for anything else. */
  get(id: string): DiscoveredGateway | undefined {
    return this.#last.get(id);
  }
}

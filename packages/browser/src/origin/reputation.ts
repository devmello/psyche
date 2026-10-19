import { canonicalizeUrl } from "./canonical.ts";

/**
 * Reputation hook (feature I7): a local blocklist, optionally followed by a remote safety check.
 * The remote check is off unless the owner turns it on (no telemetry, security §1); it receives
 * only the origin, never paths or queries.
 */
export type ReputationVerdict = "ok" | "block" | "unknown";

export interface ReputationCheck {
  check(origin: string): Promise<ReputationVerdict>;
}

/** Host-suffix blocklist: `evil.example` blocks `evil.example` and every subdomain of it. */
export class LocalBlocklist implements ReputationCheck {
  #hosts = new Set<string>();

  constructor(hosts: Iterable<string> = []) {
    for (const h of hosts) this.add(h);
  }

  add(host: string): void {
    const h = host.trim().toLowerCase().replace(/\.$/, "");
    if (h.length > 0) this.#hosts.add(h);
  }

  has(host: string): boolean {
    let h = host.toLowerCase();
    for (;;) {
      if (this.#hosts.has(h)) return true;
      const dot = h.indexOf(".");
      if (dot === -1) return false;
      h = h.slice(dot + 1);
    }
  }

  async check(origin: string): Promise<ReputationVerdict> {
    return this.has(canonicalizeUrl(origin).host) ? "block" : "ok";
  }
}

export interface ChainedReputationOptions {
  local: LocalBlocklist;
  /** Remote check (Safe Browsing-style); called only when `remoteEnabled` is true. */
  remote?: ReputationCheck;
  remoteEnabled?: boolean;
  /** Remote failures fail open by default (`unknown`); set true to fail closed. */
  failClosed?: boolean;
}

export class ChainedReputation implements ReputationCheck {
  #o: ChainedReputationOptions;
  #cache = new Map<string, ReputationVerdict>();

  constructor(options: ChainedReputationOptions) {
    this.#o = options;
  }

  async check(origin: string): Promise<ReputationVerdict> {
    if ((await this.#o.local.check(origin)) === "block") return "block";
    if (this.#o.remoteEnabled !== true || this.#o.remote === undefined) return "ok";
    const cached = this.#cache.get(origin);
    if (cached !== undefined) return cached;
    let v: ReputationVerdict;
    try {
      v = await this.#o.remote.check(origin);
    } catch {
      v = this.#o.failClosed === true ? "block" : "unknown";
    }
    this.#cache.set(origin, v);
    return v;
  }
}

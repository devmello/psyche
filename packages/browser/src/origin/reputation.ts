import { canonicalizeUrl } from "./canonical.ts";

/**
 * Reputation hook (feature I7): a local blocklist, optionally followed by a remote safety check.
 * The remote check is off unless the owner turns it on (no telemetry, security §1); it receives
 * only the origin, never paths or queries.
 */
export type ReputationVerdict = "ok" | "block" | "unknown";

export interface ReputationCheck {
  check(origin: string): Promise<ReputationVerdict>;
  /** Local-only verdict for the synchronous per-hop check (redirects, commits). */
  checkSync?(origin: string): ReputationVerdict;
}

/** Canonical (lowercased, IDNA-normalized, no trailing dot) form of a bare host. */
function normalizeHost(host: string): string {
  const h = host.trim().replace(/\.$/, "");
  if (h.length === 0) return "";
  try {
    return canonicalizeUrl(`http://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}`).host;
  } catch {
    return h.toLowerCase();
  }
}

/** Host-suffix blocklist: `evil.example` blocks `evil.example` and every subdomain of it. */
export class LocalBlocklist implements ReputationCheck {
  #hosts = new Set<string>();

  constructor(hosts: Iterable<string> = []) {
    for (const h of hosts) this.add(h);
  }

  add(host: string): void {
    const h = normalizeHost(host);
    if (h.length > 0) this.#hosts.add(h);
  }

  has(host: string): boolean {
    let h = normalizeHost(host);
    for (;;) {
      if (this.#hosts.has(h)) return true;
      const dot = h.indexOf(".");
      if (dot === -1) return false;
      h = h.slice(dot + 1);
    }
  }

  async check(origin: string): Promise<ReputationVerdict> {
    return this.checkSync(origin);
  }

  checkSync(origin: string): ReputationVerdict {
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

  checkSync(origin: string): ReputationVerdict {
    return this.#o.local.checkSync(origin) === "block"
      ? "block"
      : (this.#cache.get(origin) ?? "ok");
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
      // Not cached: a transient failure must not pin the verdict for the rest of the run.
      return this.#o.failClosed === true ? "block" : "unknown";
    }
    this.#cache.set(origin, v);
    return v;
  }
}

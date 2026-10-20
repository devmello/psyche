import {
  type CanonicalUrl,
  canonicalizeUrl,
  classifyHost,
  matchesPattern,
  type OriginPattern,
  parseOriginPattern,
} from "./canonical.ts";
import type { ReputationCheck } from "./reputation.ts";

/**
 * Per-task origin policy (architecture §8; security §6, §7.2 item 3). Each task has a set of
 * read-only and read-writable origins. The policy is a deterministic gate run on every hop:
 * the initial URL, every redirect and every committed navigation. It never decides permissions
 * itself: an origin outside the set yields `approve` and the tool layer asks the
 * PermissionBroker (`new_origin`), which applies taint and grants.
 */

export type OriginAccess = "read" | "write";

export interface OriginPolicyOptions {
  readOnly?: string[];
  readWritable?: string[];
  /** User deny rules; beat everything, including the sets. */
  deny?: string[];
  /**
   * Dev-preview tasks only (feature I12): loopback hosts are allowed and count as read-writable.
   * Everything else refuses loopback outright.
   */
  devPreview?: boolean;
  /**
   * Dev preview only: the loopback ports the task may reach (feature I12). Unset means any
   * port (M1 behaviour); set, even empty, means only these, so a dev-preview session cannot
   * wander from the owner's Vite app to another local service. `allowLoopbackPort` adds one.
   */
  loopbackPorts?: number[];
  /** Allow RFC 1918 / link-local / `.local` hosts (off by default; the owner's LAN is not web). */
  allowPrivateNetwork?: boolean;
  reputation?: ReputationCheck;
}

export type Hop = "initial" | "redirect" | "commit" | "popup" | "subresource";

export type PolicyVerdict =
  | { action: "allow"; url: CanonicalUrl; access: OriginAccess }
  | { action: "approve"; url: CanonicalUrl; reason: "new_origin" }
  | {
      action: "deny";
      reason:
        | "blocked_scheme"
        | "userinfo"
        | "invalid_url"
        | "deny_rule"
        | "loopback"
        | "private_network"
        | "reputation";
      message: string;
      origin?: string;
    };

interface Entry {
  pattern: OriginPattern;
  access: OriginAccess;
}

export class OriginPolicy {
  #entries: Entry[] = [];
  #deny: OriginPattern[];
  #devPreview: boolean;
  #loopbackPorts: Set<number> | undefined;
  #allowPrivate: boolean;
  #reputation: ReputationCheck | undefined;

  constructor(options: OriginPolicyOptions = {}) {
    for (const p of options.readOnly ?? []) this.grant(p, "read");
    for (const p of options.readWritable ?? []) this.grant(p, "write");
    this.#deny = (options.deny ?? []).map(parseOriginPattern);
    this.#devPreview = options.devPreview ?? false;
    this.#loopbackPorts =
      options.loopbackPorts === undefined ? undefined : new Set(options.loopbackPorts);
    this.#allowPrivate = options.allowPrivateNetwork ?? false;
    this.#reputation = options.reputation;
  }

  get devPreview(): boolean {
    return this.#devPreview;
  }

  /** The loopback ports a dev-preview task may reach, or undefined for any. */
  get loopbackPorts(): number[] | undefined {
    return this.#loopbackPorts === undefined ? undefined : [...this.#loopbackPorts];
  }

  /** A dev server the owner approved: its port joins the pinned set (no-op when unpinned). */
  allowLoopbackPort(port: number): void {
    this.#loopbackPorts?.add(port);
  }

  #loopbackAllowed(port: number): boolean {
    return this.#devPreview && (this.#loopbackPorts === undefined || this.#loopbackPorts.has(port));
  }

  /** Add an origin (or pattern) to the task's set; `write` upgrades an existing `read`. */
  grant(pattern: string, access: OriginAccess): void {
    const p = parseOriginPattern(pattern);
    const existing = this.#entries.find((e) => e.pattern.text === p.text);
    if (existing !== undefined) {
      if (access === "write") existing.access = "write";
      return;
    }
    this.#entries.push({ pattern: p, access });
  }

  /** The access the set gives this URL's origin, ignoring hard rules. */
  access(url: CanonicalUrl): OriginAccess | undefined {
    let best: OriginAccess | undefined;
    for (const e of this.#entries) {
      if (!matchesPattern(url, e.pattern)) continue;
      if (e.access === "write") return "write";
      best = "read";
    }
    // Dev preview: the owner's own dev server on a bare loopback host is read-writable. Named
    // `*.localhost` hosts still need an explicit set entry, so they can stand in for distinct
    // sites in tests and multi-app setups.
    if (
      best === undefined &&
      this.#loopbackAllowed(url.port) &&
      classifyHost(url.host, url.hostKind).loopback &&
      !url.host.endsWith(".localhost")
    ) {
      return "write";
    }
    return best;
  }

  /** Read-only and read-writable pattern texts, for approval cards and the Activity view. */
  describe(): { readOnly: string[]; readWritable: string[] } {
    return {
      readOnly: this.#entries.filter((e) => e.access === "read").map((e) => e.pattern.text),
      readWritable: this.#entries.filter((e) => e.access === "write").map((e) => e.pattern.text),
    };
  }

  /** Hard rules plus the set lookup, without the (possibly remote) reputation check. */
  evaluateSync(raw: string, _hop: Hop = "initial"): PolicyVerdict {
    let url: CanonicalUrl;
    try {
      url = canonicalizeUrl(raw);
    } catch (err) {
      const reason = (err as { details?: { reason?: string } }).details?.reason;
      return {
        action: "deny",
        reason:
          reason === "blocked_scheme" || reason === "userinfo" || reason === "invalid_url"
            ? reason
            : "invalid_url",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    // Deny rules ignore scheme and port: "deny example.com" means every way of reaching it.
    if (this.#deny.some((p) => matchesPattern(url, { ...p, scheme: url.scheme, port: url.port }))) {
      return {
        action: "deny",
        reason: "deny_rule",
        message: `${url.origin} is denied by a rule`,
        origin: url.origin,
      };
    }
    const net = classifyHost(url.host, url.hostKind);
    if (net.loopback && !this.#loopbackAllowed(url.port)) {
      return {
        action: "deny",
        reason: "loopback",
        message: this.#devPreview
          ? `${url.origin} is not the dev server this task previews (port ${url.port} is not allowed)`
          : `${url.origin} is a loopback address; only dev-preview tasks may open it`,
        origin: url.origin,
      };
    }
    if (net.private && !net.loopback && !this.#allowPrivate) {
      return {
        action: "deny",
        reason: "private_network",
        message: `${url.origin} is on a private network`,
        origin: url.origin,
      };
    }
    // The local blocklist (and cached remote verdicts) apply on every hop, redirects included
    // (review finding 8); only an uncached remote lookup waits for `evaluate`.
    if (this.#reputation?.checkSync?.(url.origin) === "block") {
      return {
        action: "deny",
        reason: "reputation",
        message: `${url.origin} is on the blocklist`,
        origin: url.origin,
      };
    }
    const access = this.access(url);
    if (access === undefined) return { action: "approve", url, reason: "new_origin" };
    return { action: "allow", url, access };
  }

  /** Full evaluation: hard rules, then reputation, then the set. */
  async evaluate(raw: string, hop: Hop = "initial"): Promise<PolicyVerdict> {
    const v = this.evaluateSync(raw, hop);
    if (v.action === "deny" || this.#reputation === undefined) return v;
    const rep = await this.#reputation.check(v.url.origin);
    if (rep === "block") {
      return {
        action: "deny",
        reason: "reputation",
        message: `${v.url.origin} is on the blocklist`,
        origin: v.url.origin,
      };
    }
    return v;
  }
}

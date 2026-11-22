import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  getDevice,
  getSetting,
  insertDevice,
  type PsycheDb,
  setSetting,
  updateDevice,
} from "@psyche/db";
import {
  CLAIM_SCOPES,
  type ClaimRefusal,
  claimTranscript,
  DEFAULT_GATEWAY_PORT,
  type DevicePlatform,
  type DeviceScope,
  formatSetupCode,
  PsycheError,
} from "@psyche/protocol";
import {
  claimProof,
  isClaimedHome,
  makeSetupCode,
  markClaimed,
  proofsEqual,
  readSetupCode,
  removeSetupCode,
} from "@psyche/protocol/claim-node";
import type { PeerInfo } from "../auth.ts";
import { activeAdminCount } from "../compose/bootstrap-admin.ts";
import type { LanStatus } from "../lan/listener.ts";
import { LAN_SETTING, type LanSettings, readLanSettings } from "../lan/settings.ts";
import type { Logger } from "../log.ts";
import { RateLimiter } from "../rate-limit.ts";
import { stateSealFor } from "../security/state-seal.ts";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";

/**
 * Claim mode (remote-gateway design §3.6): a fresh psyche-server with no admin device makes a
 * one-time setup code and listens on its LAN in claim mode, so the desktop app can find it, prove
 * it knows the code and become its first admin. The only terminal step left is reading the code.
 *
 * - Only a psyche-server install runs it (the composition root decides), only while no admin
 *   device exists, and never once `$PSYCHE_HOME/identity/claimed.json` says it was set up.
 * - It listens with the existing LAN listener and certificate on the default-route interface,
 *   and Bonjour adds `claim=1` to `_psyche._tcp`. The record proves nothing.
 * - Before `connect`, a LAN connection may call only `gateway.claim.hello` and
 *   `gateway.claim.prove`; `connect` itself is refused while claim mode runs.
 * - Both sides prove the code (an HMAC keyed by scrypt of it over a transcript that binds both
 *   nonces, the identity key, the certificate's SPKI and the device key), the client first. The
 *   server keys its proof with the derived key it stored, so a prove costs it one HMAC.
 * - Wrong codes are limited per address and in all; the code is single-use and lasts a day.
 * - After a claim, LAN stays on the claim's interface (persisted as `gateway.lan`, so a restart in
 *   the middle of onboarding does not strand the Mac) until onboarding's "Keep this server
 *   reachable on my network" answers `gateway.claim.finish`.
 */

/** Internal setting: the claim happened and the owner has not answered the LAN question yet. */
export const CLAIM_LAN_CHOICE_SETTING = `${INTERNAL_SETTING_PREFIX}claim.lanChoice`;

export const BOOTSTRAP_ADMIN_VIA_CLAIM = "claim";

export interface ClaimLimits {
  /** Wrong codes per address (an IPv6 peer's /64) per minute. */
  failedPerMinutePerAddress: number;
  /** Wrong codes in all per hour, so many addresses cannot add up to many guesses. */
  failedPerHourTotal: number;
  /** How often claim mode checks whether the server was set up another way (0: never). */
  watchMs: number;
}

export const DEFAULT_CLAIM_LIMITS: ClaimLimits = {
  failedPerMinutePerAddress: 5,
  failedPerHourTotal: 30,
  watchMs: 15_000,
};

/** What claim mode needs of the LAN listener. */
export interface ClaimLan {
  apply(settings: LanSettings, owner: boolean): Promise<LanStatus>;
  certSpki(): string | null;
  /** Adds or drops `claim=1` in the Bonjour record of every bound interface. */
  setClaimFlag(on: boolean): Promise<void>;
}

export interface ClaimDeps {
  home: string;
  db: PsycheDb;
  log: Logger;
  now: () => Date;
  identityKey: string;
  hostName: () => string;
  lan: ClaimLan;
  /** Where the code is shown when the Gateway makes it: stderr, which systemd puts in the journal. */
  announce?: (line: string) => void;
  /** The interface the default route goes out of (`eth0`); null for the primary one. */
  defaultInterface?: () => string | null;
  /** A device became the first admin with the code (composition root: audit it). */
  onClaimed?: (device: { id: string; name: string }) => void;
  limits?: Partial<ClaimLimits>;
  /** The LAN port claim mode listens on (default 7979; tests pick a free one). */
  port?: number;
}

/** One claim in progress: the state between `hello` and `prove` on one connection. */
export interface ClaimSession {
  clientNonce: string;
  serverNonce: string;
  salt: string;
  gatewayKey: string;
  certSpki: string;
  deviceId: string;
  publicKey: string;
  name: string;
  platform: DevicePlatform;
}

export interface ClaimHelloInput {
  clientNonce: string;
  deviceId: string;
  publicKey: string;
  name: string;
  platform: DevicePlatform;
}

function refused(reason: ClaimRefusal, message: string, extra: Record<string, unknown> = {}) {
  return new PsycheError(reason === "too_many_attempts" ? "rate_limited" : "forbidden", message, {
    details: { reason, ...extra },
    ...(reason === "too_many_attempts" ? { retryable: true } : {}),
  });
}

/**
 * The interface the IPv4 default route uses, from `/proc/net/route` (Linux). Null elsewhere or
 * when it cannot be read: the LAN listener then takes the primary interface.
 */
export function linuxDefaultRouteInterface(
  read: () => string = () => readFileSync("/proc/net/route", "utf8"),
): string | null {
  try {
    for (const line of read().split("\n").slice(1)) {
      const [name, destination, , flags] = line.trim().split(/\s+/);
      // Destination 0.0.0.0 with the route up (RTF_UP, 0x1).
      if (name && destination === "00000000" && (Number.parseInt(flags ?? "0", 16) & 1) === 1) {
        return name;
      }
    }
  } catch {
    // not Linux, or no procfs
  }
  return null;
}

export class ClaimMode {
  readonly #d: ClaimDeps;
  readonly #limits: ClaimLimits;
  readonly #perAddress: RateLimiter;
  readonly #total: RateLimiter;
  #active = false;
  #settings: LanSettings | null = null;
  #watch: ReturnType<typeof setInterval> | null = null;
  /** A prove is being decided: a second one waits for its outcome rather than racing it. */
  #deciding: Promise<unknown> = Promise.resolve();

  constructor(deps: ClaimDeps) {
    this.#d = deps;
    this.#limits = { ...DEFAULT_CLAIM_LIMITS, ...deps.limits };
    const now = () => deps.now().getTime();
    this.#perAddress = new RateLimiter(this.#limits.failedPerMinutePerAddress, 60_000, now);
    this.#total = new RateLimiter(this.#limits.failedPerHourTotal, 3_600_000, now);
  }

  /** Claim mode is running: the LAN listener answers the claim handshake and nothing else before `connect`. */
  active(): boolean {
    return this.#active;
  }

  /** The claim happened and onboarding has not answered "Keep this server reachable" yet. */
  lanChoicePending(): boolean {
    return getSetting(this.#d.db, CLAIM_LAN_CHOICE_SETTING)?.value === "pending";
  }

  /**
   * Starts claim mode when this server has never been set up. A server that already has an
   * admin device (set up from the terminal) is recorded as claimed and never enters it.
   */
  async start(): Promise<void> {
    const { home, db, now, log } = this.#d;
    if (isClaimedHome(home)) return;
    if (activeAdminCount(db) > 0) {
      this.#recordClaimed("terminal");
      return;
    }
    const stored = readSetupCode(home, now());
    if (stored === null || stored === "expired") {
      const made = await makeSetupCode(home, now());
      this.#announce(
        `Psyche: this server is not set up yet. Setup code: ${formatSetupCode(made.code)} (works once, until ${made.expiresAt}). In the Psyche app on your Mac, choose Connect to a Psyche server and type it. \`psyche setup code\` makes a new one.`,
      );
    } else {
      this.#announce(
        `Psyche: this server is not set up yet. A setup code is waiting (until ${stored.expiresAt}); run \`psyche setup code\` to see a new one.`,
      );
    }
    const iface = this.#d.defaultInterface?.() ?? null;
    this.#settings = {
      enabled: true,
      interfaces: iface === null ? [] : [iface],
      port: this.#d.port ?? DEFAULT_GATEWAY_PORT,
      ipv6: false,
    };
    this.#active = true;
    await this.#d.lan.setClaimFlag(true);
    const status = await this.#d.lan.apply(this.#settings, true);
    log.log("info", "claim mode", {
      listening: status.listening.map((l) => l.address).join(",") || "none",
      problems: status.problems.join(",") || "none",
    });
    if (this.#limits.watchMs > 0) {
      this.#watch = setInterval(() => void this.#checkSetUpElsewhere(), this.#limits.watchMs);
      this.#watch.unref();
    }
  }

  stop(): void {
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
  }

  /** `gateway.claim.hello`: hands out what the client proves its knowledge of the code over. */
  hello(peer: PeerInfo, input: ClaimHelloInput): { session: ClaimSession; result: unknown } {
    if (!this.#active || peer.lan !== true) {
      throw refused("not_claimable", "This server is not waiting to be set up");
    }
    if (activeAdminCount(this.#d.db) > 0) {
      void this.#checkSetUpElsewhere();
      throw refused("not_claimable", "This server is already set up");
    }
    this.#refuseOverLimit(peer);
    const stored = readSetupCode(this.#d.home, this.#d.now());
    if (stored === null || stored === "expired") {
      throw refused(
        "code_expired",
        "The setup code has expired; run `psyche setup code` on the server for a new one",
      );
    }
    const certSpki = this.#d.lan.certSpki();
    if (certSpki === null) throw new PsycheError("unavailable", "Not listening on the network");
    const session: ClaimSession = {
      clientNonce: input.clientNonce,
      serverNonce: randomBytes(32).toString("base64url"),
      salt: stored.salt.toString("base64url"),
      gatewayKey: this.#d.identityKey,
      certSpki,
      deviceId: input.deviceId,
      publicKey: input.publicKey,
      name: input.name,
      platform: input.platform,
    };
    return {
      session,
      result: {
        serverNonce: session.serverNonce,
        salt: session.salt,
        gatewayKey: session.gatewayKey,
        certSpki,
        hostName: (this.#d.hostName().trim() || "Psyche").slice(0, 64),
        expiresAt: stored.expiresAt,
      },
    };
  }

  /**
   * `gateway.claim.prove`: checks the client's proof; when it is right, makes the device from
   * `hello` the first admin, spends the code, ends claim mode and returns the server's proof.
   * Serialized, so two right answers cannot both make an admin.
   */
  prove(
    peer: PeerInfo,
    session: ClaimSession,
    proof: string,
  ): Promise<{ proof: string; device: { id: string; name: string }; scopes: DeviceScope[] }> {
    const run = this.#deciding.then(() => this.#prove(peer, session, proof));
    this.#deciding = run.catch(() => undefined);
    return run;
  }

  async #prove(
    peer: PeerInfo,
    session: ClaimSession,
    proof: string,
  ): Promise<{ proof: string; device: { id: string; name: string }; scopes: DeviceScope[] }> {
    const { db, home, now } = this.#d;
    if (!this.#active) throw refused("not_claimable", "This server is already set up");
    this.#refuseOverLimit(peer);
    const stored = readSetupCode(home, now());
    if (stored === null || stored === "expired") {
      throw refused(
        "code_expired",
        "The setup code has expired; run `psyche setup code` on the server for a new one",
      );
    }
    // A code made after this connection's hello (another `psyche setup code`) is another code.
    if (stored.salt.toString("base64url") !== session.salt) {
      throw refused("code_expired", "The setup code changed; type the new one");
    }
    const transcript = claimTranscript({
      clientNonce: session.clientNonce,
      serverNonce: session.serverNonce,
      salt: session.salt,
      gatewayKey: session.gatewayKey,
      certSpki: session.certSpki,
      deviceId: session.deviceId,
      devicePublicKey: session.publicKey,
    });
    if (!proofsEqual(proof, claimProof(stored.key, "client", transcript))) {
      const key = limitKey(peer);
      this.#perAddress.record(key);
      this.#total.record("all");
      const left = Math.max(
        0,
        Math.min(
          this.#limits.failedPerMinutePerAddress - this.#perAddress.count(key),
          this.#limits.failedPerHourTotal - this.#total.count("all"),
        ),
      );
      this.#d.log.log("info", "claim refused: wrong code", { attemptsLeft: left });
      throw refused("wrong_code", "That setup code is not right", { attemptsLeft: left });
    }
    const seal = stateSealFor(db);
    seal?.ensure();
    if (seal?.untrusted() != null || seal?.presenceEverEnrolled() === true) {
      throw refused("not_claimable", "This server's security records need attention first");
    }
    const device = db.sqlite
      .transaction(() => {
        if (activeAdminCount(db) > 0) {
          throw refused("not_claimable", "This server is already set up");
        }
        const at = now().toISOString();
        const scopes = [...CLAIM_SCOPES];
        const existing = getDevice(db, session.deviceId);
        if (existing?.revokedAt) {
          throw refused("not_claimable", "That device was removed from this server");
        }
        if (existing === undefined) {
          insertDevice(db, {
            id: session.deviceId,
            name: session.name,
            platform: session.platform,
            role: "client",
            publicKey: session.publicKey,
            scopes,
            pairedAt: at,
            deviceFamily: "desktop",
          });
        } else {
          updateDevice(db, existing.id, {
            name: session.name,
            publicKey: session.publicKey,
            role: "client",
            scopes,
            pairedAt: at,
            deviceFamily: "desktop",
          });
        }
        const settings = this.#settings ?? {
          enabled: true,
          interfaces: [],
          port: this.#d.port ?? DEFAULT_GATEWAY_PORT,
          ipv6: false,
        };
        // LAN stays where the claim came in until onboarding answers (gateway.claim.finish).
        setSetting(db, LAN_SETTING, { ...settings, enabled: true });
        setSetting(db, CLAIM_LAN_CHOICE_SETTING, "pending");
        return { id: session.deviceId, name: session.name };
      })
      .immediate();
    this.#recordClaimed("claim");
    try {
      this.#d.onClaimed?.(device);
    } catch {
      // the audit hook never undoes a claim
    }
    this.#d.log.log("info", "server claimed", { deviceId: device.id });
    return {
      proof: claimProof(stored.key, "server", transcript),
      device,
      scopes: [...CLAIM_SCOPES],
    };
  }

  /** `gateway.claim.finish`: the owner's answer to "Keep this server reachable on my network". */
  async finish(keepLan: boolean): Promise<{ lan: boolean }> {
    const { db } = this.#d;
    if (!this.lanChoicePending()) {
      throw new PsycheError("conflict", "There is no setup answer waiting");
    }
    setSetting(db, CLAIM_LAN_CHOICE_SETTING, "answered");
    if (keepLan) return { lan: true };
    const current = readLanSettings(getSetting(db, LAN_SETTING)?.value);
    const off = { ...current, enabled: false };
    setSetting(db, LAN_SETTING, off);
    // After the answer is out: turning LAN off closes the socket this answer goes over.
    const t = setTimeout(() => {
      this.#d.lan.apply(off, true).catch((err: unknown) =>
        this.#d.log.log("warn", "lan off after setup failed", {
          code: PsycheError.from(err).code,
        }),
      );
    }, 300);
    t.unref();
    return { lan: false };
  }

  #refuseOverLimit(peer: PeerInfo): void {
    const key = limitKey(peer);
    if (!this.#perAddress.allowed(key) || !this.#total.allowed("all")) {
      const retryAfterSec = Math.max(
        this.#perAddress.retryAfterSec(key),
        this.#total.retryAfterSec("all"),
        1,
      );
      throw refused("too_many_attempts", "Too many wrong setup codes; wait a minute", {
        retryAfterSec,
      });
    }
  }

  /** Set up from the terminal meanwhile (`psyche setup` made a CLI admin): claim mode ends. */
  async #checkSetUpElsewhere(): Promise<void> {
    if (!this.#active || activeAdminCount(this.#d.db) === 0) return;
    this.#recordClaimed("terminal");
    try {
      await this.#d.lan.setClaimFlag(false);
      // Back to what the owner chose (`psyche lan on`), or loopback.
      await this.#d.lan.apply(readLanSettings(getSetting(this.#d.db, LAN_SETTING)?.value), false);
    } catch (err) {
      this.#d.log.log("warn", "leaving claim mode failed", { code: PsycheError.from(err).code });
    }
  }

  #recordClaimed(via: "claim" | "terminal"): void {
    this.#active = false;
    this.stop();
    removeSetupCode(this.#d.home);
    try {
      markClaimed(this.#d.home, via, this.#d.now());
    } catch (err) {
      this.#d.log.log("warn", "could not record that the server is set up", {
        code: PsycheError.from(err).code,
      });
    }
    if (via === "claim") void this.#d.lan.setClaimFlag(false).catch(() => undefined);
  }

  #announce(line: string): void {
    try {
      (this.#d.announce ?? ((l: string) => process.stderr.write(`${l}\n`)))(line);
    } catch {
      // nowhere to say it
    }
  }
}

function limitKey(peer: PeerInfo): string {
  return peer.limitKey ?? peer.remoteAddress;
}

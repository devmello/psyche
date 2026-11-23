import { existsSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { PairingLinkError, PsycheError, parsePairingLinkAny } from "@psyche/protocol";
import {
  ClaimError,
  type ClaimedServer,
  type ClaimOptions,
  claimServer,
} from "../lib/claim-client.ts";
import { type DeviceKey, loadOrCreateDeviceKey, platformFromNode } from "../lib/device-key.ts";
import { fingerprintOf } from "../lib/gateway-identity.ts";
import {
  addGateway,
  addGatewayFromClaim,
  addGatewayFromLanLink,
  addGatewayFromLink,
  claimOriginFor,
  clearGatewayPin,
  clearSetupToken,
  defaultGatewayName,
  forgetGatewayData,
  GatewayAddressError,
  GatewayLinkError,
  type GatewaysFile,
  type GatewayTarget,
  gatewayDataDir,
  isLanOrigin,
  liveSetupToken,
  loadGatewaysStrict,
  newGatewayId,
  pinGatewayCert,
  pinGatewayKey,
  removeGateway,
  renameGateway,
  type SavedGateway,
  saveGateways,
  setActiveGateway,
  THIS_MAC_ID,
  touchGateway,
} from "../lib/gateways.ts";
import { hostPlatform } from "../platform/index.ts";

/**
 * Owns the saved Gateways for the main process (remote-gateway design §1.3): the list the avatar
 * menu shows, adding and forgetting a Gateway, switching, and the pin of the active one.
 *
 * The renderer may ask for any of this, but the renderer is untrusted input and the address of a
 * Gateway decides where this app sends its signed handshake. So every change that adds, forgets
 * or re-pairs a Gateway goes through `confirm`, a native dialog the renderer cannot click or
 * draw, which names the address main normalized. Switching to a Gateway the owner already saved
 * needs none: it was confirmed when it was added.
 */

export interface SavedGatewayView {
  id: string;
  name: string;
  /** The address; This Mac shows none. */
  origin: string | null;
  /** A Gateway on another computer. */
  remote: boolean;
  active: boolean;
  /** An identity is pinned: the key (the first connect has happened) or a link's fingerprint. */
  pinned: boolean;
  /** On the local network: reached over a pinned self-signed certificate. */
  lan: boolean;
}

export type GatewayConfirm =
  | { kind: "add"; origin: string; name: string; fingerprint?: string }
  /** A `.local` or private address: add it as a Psyche on this network, or as a plain https one. */
  | { kind: "addLan"; origin: string; name: string; fingerprint?: string }
  /**
   * From a pairing link: names the address and the identity the Gateway must prove (its
   * fingerprint), never the link's own host name. `external`: the link was opened by another app
   * or a website, not pasted by the owner.
   */
  | {
      kind: "addLink";
      origin: string;
      fingerprint: string;
      external: boolean;
      /** A `psyche-pair:v2` link: a Psyche on this network, held to the certificate it names. */
      lan?: { certPin: string };
    }
  /** Set up the psyche-server at this address with its setup code (design §3.6). */
  | { kind: "claim"; origin: string }
  | { kind: "forget"; name: string; origin: string }
  | { kind: "repair"; name: string; origin: string }
  | { kind: "stopLocal" };

export interface GatewayManagerDeps {
  /** The base `userData` (where `gateways.json` lives), not a remote Gateway's own directory. */
  userData: string;
  /** What this launch connects to. */
  target: GatewayTarget;
  /** The native confirmation; resolves true when the owner confirmed. */
  confirm: (c: GatewayConfirm) => Promise<boolean | "plain">;
  /** Restarts the app (a switch applies to every module at once by starting over). */
  relaunch: () => void;
  /** Stops this Mac's own Gateway (the optional step when switching away from This Mac). */
  stopLocal?: () => Promise<void>;
  now?: () => Date;
  /** Tests: the claim handshake (default `claimServer`). */
  claimServer?: (opts: ClaimOptions) => Promise<ClaimedServer>;
}

export class GatewayManager {
  readonly #deps: GatewayManagerDeps;
  readonly #file: string;
  /** Claims whose answer was lost, by server origin: the Gateway id (and so device key) to retry with. */
  readonly #pendingClaims = new Map<string, string>();

  constructor(deps: GatewayManagerDeps) {
    this.#deps = deps;
    this.#file = join(deps.userData, "gateways.json");
  }

  /**
   * The file, for reading and for any write. A file that cannot be understood is an error here
   * (never an empty list): nothing is written over it, and the list shows only This Mac.
   */
  #load(): GatewaysFile {
    try {
      return loadGatewaysStrict(this.#file, this.#deps.now?.() ?? new Date());
    } catch (err) {
      throw new PsycheError(
        "unavailable",
        err instanceof Error ? err.message : "the saved Gateways file cannot be read",
      );
    }
  }

  list(): SavedGatewayView[] {
    let data: GatewaysFile;
    try {
      data = this.#load();
    } catch {
      data = { v: 1, active: THIS_MAC_ID, gateways: [] };
    }
    const activeId = this.#deps.target.id === "env" ? THIS_MAC_ID : this.#deps.target.id;
    return [
      {
        id: THIS_MAC_ID,
        name: "This Mac",
        origin: null,
        remote: false,
        active: activeId === THIS_MAC_ID,
        pinned: false,
        lan: false,
      },
      ...data.gateways.map((g) => ({
        id: g.id,
        name: g.name,
        origin: g.origin,
        remote: true,
        active: g.id === activeId,
        pinned: g.identityKey !== undefined || g.identityFingerprint !== undefined,
        lan: g.lan === true,
      })),
    ];
  }

  #find(id: string): SavedGateway {
    const found = this.#load().gateways.find((g) => g.id === id);
    if (found === undefined) throw new PsycheError("not_found", "That Gateway is not saved");
    return found;
  }

  /** Adds the Gateway for `address` after the owner confirms it in a native dialog. */
  async add(
    address: string,
    name?: string,
    hints?: {
      certPin?: string;
      identityKey?: string;
      advertisedFingerprint?: string;
      lan?: boolean;
    },
  ): Promise<SavedGatewayView> {
    let chosen = hints;
    const attempt = () => {
      try {
        return addGateway(this.#load(), {
          address,
          ...(name === undefined ? {} : { name }),
          ...(chosen === undefined ? {} : { hints: chosen }),
        });
      } catch (err) {
        if (err instanceof GatewayAddressError) {
          throw new PsycheError("invalid_params", err.message, {
            details: { problem: err.problem },
          });
        }
        throw err;
      }
    };
    const first = attempt();
    if (first.existing) return this.#view(first.entry);
    // A `.local` or private address that was not picked from the network asks which it is: only
    // the owner knows whether it is a Psyche on this network or a proxy with its own certificate.
    const asksLan = chosen?.lan === undefined && isLanOrigin(first.entry.origin);
    const ok = await this.#deps.confirm({
      kind: asksLan ? "addLan" : "add",
      origin: first.entry.origin,
      name: first.entry.name,
      ...(first.entry.advertisedFingerprint === undefined
        ? {}
        : { fingerprint: first.entry.advertisedFingerprint }),
    });
    if (ok === false) throw new PsycheError("forbidden", "Adding the Gateway was cancelled");
    if (asksLan) chosen = { ...chosen, lan: ok === true };
    // The file is read again after the dialog: it may have changed while the owner decided (a pin
    // written by a connection), and saving the copy read before would erase that.
    const result = attempt();
    if (!result.existing) saveGateways(this.#file, result.gateways);
    return this.#view(result.entry);
  }

  /**
   * Adds (or updates) the Gateway a pasted `psyche-pair:v1` or `psyche-pair:v2` link names, after the owner confirms
   * the normalized address in a native dialog. The link is parsed strictly here, in main, from the
   * raw text: nothing the renderer parsed is trusted. The link's fingerprint becomes the pre-pin
   * and its token is kept for the first connect (never given back to the renderer).
   */
  async addFromLink(rawLink: string, opts: { external?: boolean } = {}): Promise<SavedGatewayView> {
    let link: ReturnType<typeof parsePairingLinkAny>;
    try {
      link = parsePairingLinkAny(rawLink);
    } catch (err) {
      if (err instanceof PairingLinkError) {
        throw new PsycheError("invalid_params", err.message, {
          details: { problem: `link_${err.problem}` },
        });
      }
      throw err;
    }
    const attempt = () => {
      try {
        const now = this.#deps.now?.() ?? new Date();
        return link.version === 2
          ? addGatewayFromLanLink(this.#load(), link.payload, now)
          : addGatewayFromLink(this.#load(), link.payload, now);
      } catch (err) {
        if (err instanceof GatewayAddressError) {
          throw new PsycheError("invalid_params", err.message, {
            details: { problem: err.problem },
          });
        }
        if (err instanceof GatewayLinkError) {
          throw new PsycheError("invalid_params", err.message, {
            details: {
              problem:
                err.problem === "lan_not_supported"
                  ? "link_lan"
                  : err.problem === "not_lan"
                    ? "link_not_lan"
                    : "link_pin_mismatch",
            },
          });
        }
        throw err;
      }
    };
    const first = attempt();
    const ok = await this.#deps.confirm({
      kind: "addLink",
      origin: first.entry.origin,
      fingerprint:
        link.version === 2
          ? fingerprintOf(link.payload.gatewayKey)
          : link.payload.gatewayFingerprint,
      external: opts.external === true,
      ...(link.version === 2 ? { lan: { certPin: link.payload.certPin } } : {}),
    });
    if (!ok) throw new PsycheError("forbidden", "Adding the Gateway was cancelled");
    // Read again after the dialog, as `add` does, so a pin written meanwhile is not erased.
    const result = attempt();
    saveGateways(this.#file, result.gateways);
    return this.#view(result.entry);
  }

  /**
   * "Set up a remote server" (remote-gateway design §3.6): claims the unclaimed psyche-server at
   * `address` with the setup code the owner read off it, then saves it pinned to the identity key
   * and certificate it proved, under the id whose device key is now its first admin. The address
   * is confirmed in a native dialog first, like every add. Nothing is saved, and the device key
   * made for it is removed, unless the server proved it knows the code.
   */
  async claim(address: string, code: string): Promise<SavedGatewayView> {
    let origin: string;
    try {
      origin = claimOriginFor(address);
    } catch (err) {
      if (err instanceof GatewayAddressError) {
        throw new PsycheError("invalid_params", err.message, {
          details: { problem: err.problem === "invalid" ? "claim_not_lan" : err.problem },
        });
      }
      throw err;
    }
    const found = () => this.#load().gateways.find((g) => g.origin === origin);
    const before = found();
    if (before?.identityKey !== undefined || before?.certPin !== undefined) {
      // Paired before: that server is set up, and its pins are not replaced by a claim.
      throw new PsycheError("conflict", "That server is saved already", {
        details: { problem: "claim_saved" },
      });
    }
    const ok = await this.#deps.confirm({ kind: "claim", origin });
    if (!ok) throw new PsycheError("forbidden", "Setting up the server was cancelled");
    // A claim whose answer was lost keeps its id (and so its device key): the server may already
    // have made that key its admin, and a retry from the same key finishes the claim.
    const retrying = this.#pendingClaims.has(origin);
    const id = found()?.id ?? this.#pendingClaims.get(origin) ?? newGatewayId();
    const dir = gatewayDataDir(this.#deps.userData, id);
    const fresh = retrying || !existsSync(dir);
    const key: DeviceKey = loadOrCreateDeviceKey(join(dir, "device-key.json"));
    const url = new URL(origin);
    let claimed: ClaimedServer;
    try {
      claimed = await (this.#deps.claimServer ?? claimServer)({
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port || 443),
        code,
        device: {
          deviceId: key.deviceId,
          publicKey: key.publicKey,
          name: `Psyche Desktop (${hostname()})`.slice(0, 64),
          platform: platformFromNode(hostPlatform()),
        },
      });
    } catch (err) {
      const problem = err instanceof ClaimError ? err.problem : null;
      // Keep the key only when it may be the server's admin by now: the proof went out and no
      // answer came back. A retry also keeps it through a wrong code, a rate limit or a bad
      // connection, which prove nothing about the server's state.
      const keep =
        problem === "unconfirmed" ||
        (retrying &&
          (problem === "wrong_code" ||
            problem === "too_many_attempts" ||
            problem === "unreachable"));
      if (keep) this.#pendingClaims.set(origin, id);
      else {
        this.#pendingClaims.delete(origin);
        if (fresh) forgetGatewayData(this.#deps.userData, id);
      }
      if (err instanceof ClaimError) {
        // The server dropped what a retry needs (or never knew this key): say what to do next.
        const gone =
          retrying && (err.problem === "not_claimable" || err.problem === "code_expired");
        const shown =
          err.problem === "unconfirmed" ? "unreachable" : gone ? "maybe_claimed" : err.problem;
        throw new PsycheError("forbidden", `The server was not set up (${shown})`, {
          details: {
            problem: `claim_${shown}`,
            ...(err.attemptsLeft === undefined ? {} : { attemptsLeft: err.attemptsLeft }),
            ...(err.retryAfterSec === undefined ? {} : { retryAfterSec: err.retryAfterSec }),
          },
        });
      }
      throw err;
    }
    this.#pendingClaims.delete(origin);
    // Read again after the handshake, so a write made meanwhile is not erased.
    const result = addGatewayFromClaim(
      this.#load(),
      { origin, gatewayKey: claimed.gatewayKey, certPin: claimed.certSpki },
      id,
    );
    saveGateways(this.#file, result.gateways);
    return this.#view(result.entry);
  }

  #view(entry: SavedGateway): SavedGatewayView {
    return {
      id: entry.id,
      name: entry.name,
      origin: entry.origin,
      remote: true,
      active: this.#deps.target.id === entry.id,
      pinned: entry.identityKey !== undefined || entry.identityFingerprint !== undefined,
      lan: entry.lan === true,
    };
  }

  rename(id: string, name: string): void {
    this.#find(id);
    saveGateways(this.#file, renameGateway(this.#load(), id, name));
  }

  /**
   * Forgets a Gateway: its entry, pin, device key and storage. The Host is not told here (it still
   * lists this computer until an admin removes it); asking it to revoke is a follow-up.
   */
  async remove(id: string): Promise<void> {
    const entry = this.#find(id);
    const ok = await this.#deps.confirm({
      kind: "forget",
      name: entry.name,
      origin: entry.origin,
    });
    if (!ok) throw new PsycheError("forbidden", "Forgetting the Gateway was cancelled");
    this.#find(id);
    saveGateways(this.#file, removeGateway(this.#load(), id));
    if (this.#deps.target.id === id) {
      // This app is running out of that directory: Chromium writes into it until the process
      // exits, so it is swept at the next start (`sweepForgottenData`). The app starts over on
      // This Mac.
      this.#deps.relaunch();
    } else {
      forgetGatewayData(this.#deps.userData, id);
    }
  }

  /** Deletes the data directory of every Gateway that is no longer saved (a forgotten active one). */
  sweepForgottenData(): void {
    let saved: SavedGateway[];
    try {
      saved = this.#load().gateways;
    } catch {
      return; // an unreadable file: delete nothing
    }
    const keep = new Set([this.#deps.target.id, ...saved.map((g) => g.id)]);
    let names: string[];
    try {
      names = readdirSync(join(this.#deps.userData, "gateways"));
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name) || !/^gw_[0-9a-f]{12}$/.test(name)) continue;
      forgetGatewayData(this.#deps.userData, name);
    }
  }

  /** Switches the active Gateway and restarts the app. `stopLocal` also stops this Mac's own. */
  async switchTo(id: string, opts: { stopLocal?: boolean } = {}): Promise<void> {
    if (id !== THIS_MAC_ID) this.#find(id);
    if (opts.stopLocal === true && this.#deps.stopLocal) {
      const ok = await this.#deps.confirm({ kind: "stopLocal" });
      if (ok) await this.#deps.stopLocal();
    }
    // Read after the dialog, so a pin written meanwhile survives.
    if (id !== THIS_MAC_ID) this.#find(id);
    saveGateways(this.#file, setActiveGateway(this.#load(), id));
    this.#deps.relaunch();
  }

  /**
   * "Forget and pair again": drops the pin and this computer's device key for that Gateway, so
   * the next connect pins whatever answers and pairs as a new device. Used when a Gateway's
   * identity changed on purpose (the Host was rebuilt or rotated its key) or this computer was
   * removed from it.
   */
  async repair(id: string): Promise<void> {
    const entry = this.#find(id);
    const ok = await this.#deps.confirm({ kind: "repair", name: entry.name, origin: entry.origin });
    if (!ok) throw new PsycheError("forbidden", "Pairing again was cancelled");
    this.#find(id);
    saveGateways(this.#file, clearGatewayPin(this.#load(), id));
    rmSync(join(gatewayDataDir(this.#deps.userData, id), "device-key.json"), { force: true });
    if (this.#deps.target.id === id) this.#deps.relaunch();
  }

  /**
   * The pinned key of the active saved Gateway; read per connect attempt. Throws when the file
   * cannot be understood or the entry is gone, so the attempt fails instead of running unpinned.
   */
  pinnedKey(): string | undefined {
    if (!this.#deps.target.remote) return undefined;
    const entry = this.#load().gateways.find((g) => g.id === this.#deps.target.id);
    if (entry === undefined)
      throw new PsycheError("unavailable", "the active Gateway is not saved");
    return entry.identityKey;
  }

  /**
   * The fingerprint a pairing link named for the active saved Gateway, while its key is not
   * pinned yet. Read per attempt; throws like `pinnedKey`.
   */
  pinnedFingerprint(): string | undefined {
    if (!this.#deps.target.remote) return undefined;
    const entry = this.#load().gateways.find((g) => g.id === this.#deps.target.id);
    if (entry === undefined)
      throw new PsycheError("unavailable", "the active Gateway is not saved");
    return entry.identityFingerprint;
  }

  /**
   * The setup token to present at this connect, if the active saved Gateway has one still worth
   * sending. It goes to the connection, never to the renderer. A lapsed token is dropped here.
   */
  setupToken(): string | undefined {
    if (!this.#deps.target.remote) return undefined;
    const data = this.#load();
    const entry = data.gateways.find((g) => g.id === this.#deps.target.id);
    if (entry?.setupToken === undefined) return undefined;
    const token = liveSetupToken(entry, this.#deps.now?.() ?? new Date());
    if (token === undefined) saveGateways(this.#file, clearSetupToken(data, entry.id));
    return token;
  }

  /** Forgets the active Gateway's token: it was spent, or the Host refused it. */
  clearSetupToken(): void {
    if (!this.#deps.target.remote) return;
    const data = this.#load();
    const entry = data.gateways.find((g) => g.id === this.#deps.target.id);
    if (entry?.setupToken === undefined) return;
    saveGateways(this.#file, clearSetupToken(data, entry.id));
  }

  /** Trust on first use: stores the key the active Gateway proved at its first connect. */
  pin(key: string): void {
    if (!this.#deps.target.remote) return;
    const data = this.#load();
    const entry = data.gateways.find((g) => g.id === this.#deps.target.id);
    if (entry === undefined || entry.identityKey !== undefined) return;
    saveGateways(this.#file, pinGatewayKey(data, this.#deps.target.id, key));
  }

  /**
   * Names the active saved Gateway by the Host's own name (from `gateway.info`, once paired), but
   * only while it still has the name it got from its address: a name the owner chose stays.
   */
  adoptHostName(hostName: string): void {
    if (!this.#deps.target.remote) return;
    const data = this.#load();
    const entry = data.gateways.find((g) => g.id === this.#deps.target.id);
    if (entry === undefined || entry.name !== defaultGatewayName(entry.origin)) return;
    const next = renameGateway(data, entry.id, hostName);
    if (next !== data) saveGateways(this.#file, next);
  }

  /** The pinned certificate (SPKI) of the active LAN Gateway; throws like `pinnedKey`. */
  pinnedCert(): string | undefined {
    if (!this.#deps.target.remote) return undefined;
    const entry = this.#load().gateways.find((g) => g.id === this.#deps.target.id);
    if (entry === undefined)
      throw new PsycheError("unavailable", "the active Gateway is not saved");
    return entry.certPin;
  }

  /** Trust on first use for the certificate, stored once the connection is paired. */
  pinCert(spki: string): void {
    if (!this.#deps.target.remote) return;
    const data = this.#load();
    const entry = data.gateways.find((g) => g.id === this.#deps.target.id);
    if (entry === undefined || entry.certPin !== undefined) return;
    saveGateways(this.#file, pinGatewayCert(data, this.#deps.target.id, spki));
  }

  /** The key fingerprint Bonjour announced for the active Gateway, while no key is pinned. */
  advertisedFingerprint(): string | undefined {
    if (!this.#deps.target.remote) return undefined;
    try {
      return this.#load().gateways.find((g) => g.id === this.#deps.target.id)
        ?.advertisedFingerprint;
    } catch {
      return undefined;
    }
  }

  /** Remembers when the active saved Gateway last paired. */
  markConnected(): void {
    if (!this.#deps.target.remote) return;
    if (!this.#load().gateways.some((g) => g.id === this.#deps.target.id)) return;
    const at = (this.#deps.now?.() ?? new Date()).toISOString();
    // Paired: a token this computer held has done its job (or was not needed).
    saveGateways(
      this.#file,
      clearSetupToken(touchGateway(this.#load(), this.#deps.target.id, at), this.#deps.target.id),
    );
  }
}

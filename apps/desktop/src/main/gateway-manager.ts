import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import {
  addGateway,
  clearGatewayPin,
  forgetGatewayData,
  GatewayAddressError,
  type GatewaysFile,
  type GatewayTarget,
  gatewayDataDir,
  isLanOrigin,
  loadGatewaysStrict,
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
  /** An identity key is pinned (the first connect has happened). */
  pinned: boolean;
  /** On the local network: reached over a pinned self-signed certificate. */
  lan: boolean;
}

export type GatewayConfirm =
  | { kind: "add"; origin: string; name: string; fingerprint?: string }
  /** A `.local` or private address: add it as a Psyche on this network, or as a plain https one. */
  | { kind: "addLan"; origin: string; name: string; fingerprint?: string }
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
}

export class GatewayManager {
  readonly #deps: GatewayManagerDeps;
  readonly #file: string;

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
      return loadGatewaysStrict(this.#file);
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
        pinned: g.identityKey !== undefined,
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

  #view(entry: SavedGateway): SavedGatewayView {
    return {
      id: entry.id,
      name: entry.name,
      origin: entry.origin,
      remote: true,
      active: this.#deps.target.id === entry.id,
      pinned: entry.identityKey !== undefined,
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

  /** Trust on first use: stores the key the active Gateway proved at its first connect. */
  pin(key: string): void {
    if (!this.#deps.target.remote) return;
    const data = this.#load();
    const entry = data.gateways.find((g) => g.id === this.#deps.target.id);
    if (entry === undefined || entry.identityKey !== undefined) return;
    saveGateways(this.#file, pinGatewayKey(data, this.#deps.target.id, key));
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
    saveGateways(this.#file, touchGateway(this.#load(), this.#deps.target.id, at));
  }
}

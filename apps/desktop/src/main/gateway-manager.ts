import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import {
  addGateway,
  addGatewayFromLink,
  clearGatewayPin,
  clearSetupToken,
  forgetGatewayData,
  GatewayAddressError,
  type GatewaysFile,
  type GatewayTarget,
  gatewayDataDir,
  identityKeyFingerprint,
  isPairingLinkText,
  liveSetupToken,
  loadGatewaysStrict,
  PairingLinkError,
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
}

export type GatewayConfirm =
  | { kind: "add"; origin: string; name: string; viaLink?: { fingerprint: string } }
  | { kind: "forget"; name: string; origin: string }
  | { kind: "repair"; name: string; origin: string }
  | { kind: "stopLocal" };

export interface GatewayManagerDeps {
  /** The base `userData` (where `gateways.json` lives), not a remote Gateway's own directory. */
  userData: string;
  /** What this launch connects to. */
  target: GatewayTarget;
  /** The native confirmation; resolves true when the owner confirmed. */
  confirm: (c: GatewayConfirm) => Promise<boolean>;
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
      },
      ...data.gateways.map((g) => ({
        id: g.id,
        name: g.name,
        origin: g.origin,
        remote: true,
        active: g.id === activeId,
        pinned: g.identityKey !== undefined,
      })),
    ];
  }

  #find(id: string): SavedGateway {
    const found = this.#load().gateways.find((g) => g.id === id);
    if (found === undefined) throw new PsycheError("not_found", "That Gateway is not saved");
    return found;
  }

  /**
   * Adds the Gateway for `address` after the owner confirms it in a native dialog. `address` may
   * be a pasted `psyche-pair:v1` link instead, which carries the address and the identity key (so
   * nothing is trusted on first use) and a single-use setup token for the first connect.
   */
  async add(address: string, name?: string): Promise<SavedGatewayView> {
    if (isPairingLinkText(address)) return this.#addFromLink(address, name);
    const attempt = () => {
      try {
        return addGateway(this.#load(), { address, ...(name === undefined ? {} : { name }) });
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
    const ok = await this.#deps.confirm({
      kind: "add",
      origin: first.entry.origin,
      name: first.entry.name,
    });
    if (!ok) throw new PsycheError("forbidden", "Adding the Gateway was cancelled");
    // The file is read again after the dialog: it may have changed while the owner decided (a pin
    // written by a connection), and saving the copy read before would erase that.
    const result = attempt();
    if (!result.existing) saveGateways(this.#file, result.gateways);
    return this.#view(result.entry);
  }

  async #addFromLink(text: string, name?: string): Promise<SavedGatewayView> {
    const attempt = () => {
      try {
        return addGatewayFromLink(
          this.#load(),
          { link: text, ...(name === undefined ? {} : { name }) },
          this.#deps.now?.() ?? new Date(),
        );
      } catch (err) {
        if (err instanceof PairingLinkError) {
          throw new PsycheError("invalid_params", err.message, {
            details: { problem: err.problem },
          });
        }
        throw err;
      }
    };
    const first = attempt();
    const ok = await this.#deps.confirm({
      kind: "add",
      origin: first.entry.origin,
      name: first.entry.name,
      viaLink: { fingerprint: identityKeyFingerprint(first.link.gatewayIdentityKey) },
    });
    if (!ok) throw new PsycheError("forbidden", "Adding the Gateway was cancelled");
    // Read again after the dialog, and the link's ten minutes keep running while the owner decides.
    const result = attempt();
    saveGateways(this.#file, result.gateways);
    return this.#view(result.entry);
  }

  /**
   * The setup token to send at the next connect to the active saved Gateway, if one is saved and
   * still within its ten minutes. Never read for This Mac or the dev environment path.
   */
  setupToken(): string | undefined {
    if (!this.#deps.target.remote) return undefined;
    try {
      const entry = this.#load().gateways.find((g) => g.id === this.#deps.target.id);
      return entry === undefined
        ? undefined
        : liveSetupToken(entry, this.#deps.now?.() ?? new Date());
    } catch {
      return undefined;
    }
  }

  /** The Gateway has answered the connect (pending or paired): the token is spent, forget it. */
  clearSetupToken(): void {
    if (!this.#deps.target.remote) return;
    try {
      const data = this.#load();
      const entry = data.gateways.find((g) => g.id === this.#deps.target.id);
      if (entry?.setupToken === undefined) return;
      saveGateways(this.#file, clearSetupToken(data, entry.id));
    } catch {
      // An unreadable file is reported elsewhere; the token is short-lived anyway.
    }
  }

  #view(entry: SavedGateway): SavedGatewayView {
    return {
      id: entry.id,
      name: entry.name,
      origin: entry.origin,
      remote: true,
      active: this.#deps.target.id === entry.id,
      pinned: entry.identityKey !== undefined,
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

  /** Remembers when the active saved Gateway last paired. */
  markConnected(): void {
    if (!this.#deps.target.remote) return;
    if (!this.#load().gateways.some((g) => g.id === this.#deps.target.id)) return;
    const at = (this.#deps.now?.() ?? new Date()).toISOString();
    saveGateways(this.#file, touchGateway(this.#load(), this.#deps.target.id, at));
  }
}

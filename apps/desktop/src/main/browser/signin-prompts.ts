import type { SignedInStore } from "./signed-in-sites.ts";

/**
 * The two prompts after the owner signs in inside an agent tab (security §6, §4):
 *
 * - `stay_signed_in`: "Stay signed in to <site>?" for a clean tab. Yes moves the site's cookies
 *   into the persistent profile and adds the origin to the signed-in list.
 * - `save_login`: "Save login to Psyche vault?" with the real origin, the username and a masked
 *   password. Yes sends the item straight from main to the vault; "Never for this site" stops
 *   asking for that origin.
 *
 * The password stays in this object. The views the renderer receives carry the username and
 * origin only; the vault call is the only place the value leaves, and errors keep a code and no
 * value.
 */

export type SignInPromptView =
  | { id: string; tabId: string; kind: "stay_signed_in"; origin: string; hosts: string[] }
  | {
      id: string;
      tabId: string;
      kind: "save_login";
      origin: string;
      username: string;
      /** A short code when the last save failed (`vault_locked`, `forbidden`, …). */
      error?: string;
    };

export type SignInPromptAnswer = "accept" | "dismiss" | "never";

export interface VaultLoginItem {
  kind: "login";
  name: string;
  bindings: { origin: string }[];
  secret: { username: string; password: string };
}

export interface SignInPromptsOptions {
  store: SignedInStore;
  /** Main → Gateway `vault.add`; resolves when stored. */
  vaultAdd(item: VaultLoginItem): Promise<void>;
  /** Moves cookies into the profile and the tab onto it. */
  stay(tabId: string, origin: string, hosts: string[]): Promise<void>;
  changed(): void;
  newId?(): string;
}

interface Entry {
  view: SignInPromptView;
  password?: string;
}

function errorCode(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[a-z_]{1,40}$/.test(c) ? c : "failed";
}

export class SignInPrompts {
  readonly #entries = new Map<string, Entry>();
  readonly #o: SignInPromptsOptions;
  #seq = 0;

  constructor(o: SignInPromptsOptions) {
    this.#o = o;
  }

  views(): SignInPromptView[] {
    return [...this.#entries.values()].map((e) => structuredClone(e.view));
  }

  #id(): string {
    return this.#o.newId?.() ?? `sp_${++this.#seq}`;
  }

  #has(tabId: string, kind: SignInPromptView["kind"], origin: string): boolean {
    return [...this.#entries.values()].some(
      (e) => e.view.tabId === tabId && e.view.kind === kind && e.view.origin === origin,
    );
  }

  offerStay(tabId: string, origin: string, hosts: string[]): void {
    if (this.#o.store.has(origin) || this.#has(tabId, "stay_signed_in", origin)) return;
    const id = this.#id();
    this.#entries.set(id, {
      view: { id, tabId, kind: "stay_signed_in", origin, hosts: [...hosts].sort() },
    });
    this.#o.changed();
  }

  offerSave(tabId: string, origin: string, username: string, password: string): void {
    if (this.#o.store.isNeverSave(origin) || this.#has(tabId, "save_login", origin)) return;
    const id = this.#id();
    this.#entries.set(id, { view: { id, tabId, kind: "save_login", origin, username }, password });
    this.#o.changed();
  }

  /** Forgets a tab's prompts (the tab closed or moved). */
  dropTab(tabId: string): void {
    let any = false;
    for (const [id, e] of this.#entries) {
      if (e.view.tabId !== tabId) continue;
      delete e.password;
      this.#entries.delete(id);
      any = true;
    }
    if (any) this.#o.changed();
  }

  async answer(id: string, action: SignInPromptAnswer): Promise<void> {
    const e = this.#entries.get(id);
    if (e === undefined) return;
    const v = e.view;
    if (action === "dismiss" || (action === "never" && v.kind === "stay_signed_in")) {
      this.#finish(id);
      return;
    }
    if (action === "never") {
      this.#o.store.neverSave(v.origin);
      // Every pending offer for this origin goes with it.
      for (const [otherId, o] of this.#entries) {
        if (o.view.kind === "save_login" && o.view.origin === v.origin) this.#finish(otherId);
      }
      return;
    }
    if (v.kind === "stay_signed_in") {
      try {
        await this.#o.stay(v.tabId, v.origin, v.hosts);
      } finally {
        // The tab is replaced either way; the prompt is done.
        this.#finish(id);
      }
      return;
    }
    const password = e.password;
    if (password === undefined) {
      this.#finish(id);
      return;
    }
    try {
      await this.#o.vaultAdd({
        kind: "login",
        name: new URL(v.origin).host,
        bindings: [{ origin: v.origin }],
        secret: { username: v.username, password },
      });
      this.#finish(id);
    } catch (err) {
      // Keep the offer so the owner can unlock the vault and retry; show a code, never a value.
      v.error = errorCode(err);
      this.#o.changed();
    }
  }

  #finish(id: string): void {
    const e = this.#entries.get(id);
    if (e !== undefined) delete e.password;
    this.#entries.delete(id);
    this.#o.changed();
  }
}

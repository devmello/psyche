import type { NodeClient } from "@psyche/protocol";
import { fail } from "../errors.ts";
import {
  fromB64url,
  helperUnavailable,
  invokeHelper,
  KEYCHAIN_ITEM_CAPABILITIES,
  promptReason,
  toB64url,
} from "./helper.ts";

export interface KeychainItemStoreOptions {
  helper: NodeClient;
  /** Name prefix in Psyche's access group. Default `psyche.item.` */
  prefix?: string;
  /** Gate every read behind Touch ID or the login password (default true). */
  requireAuth?: boolean;
}

/**
 * System keychain mode (feature G9): item secrets live as Psyche items in the data-protection
 * keychain (Psyche's own access group; never Safari / Passwords items), written and read through
 * the helper's `keychain.store` / `keychain.retrieve` / `keychain.delete`. The vault database
 * keeps only metadata and bindings for them.
 */
export class KeychainItemStore {
  readonly #helper: NodeClient;
  readonly #prefix: string;
  readonly #requireAuth: boolean;
  #available = false;

  constructor(options: KeychainItemStoreOptions) {
    this.#helper = options.helper;
    this.#prefix = options.prefix ?? "psyche.item.";
    this.#requireAuth = options.requireAuth ?? true;
  }

  get requireAuth(): boolean {
    return this.#requireAuth;
  }

  unavailableReason(): Promise<string | null> {
    return helperUnavailable(this.#helper, [
      KEYCHAIN_ITEM_CAPABILITIES.store,
      KEYCHAIN_ITEM_CAPABILITIES.retrieve,
      KEYCHAIN_ITEM_CAPABILITIES.deleteItem,
      KEYCHAIN_ITEM_CAPABILITIES.status,
    ]);
  }

  /** `psyche.item.<id>`, lowercased and limited to the helper's name grammar. */
  nameFor(itemId: string): string {
    const name = `${this.#prefix}${itemId.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`;
    if (name.length > 64) return fail("invalid_params", "item id too long for a keychain name");
    return name;
  }

  /** Fail early with a clear reason when the helper lacks the item capabilities. */
  async #ensure(): Promise<void> {
    if (this.#available) return;
    const reason = await this.unavailableReason();
    if (reason !== null)
      return fail("unavailable", `system keychain mode is unavailable: ${reason}`);
    this.#available = true;
  }

  async put(itemId: string, value: Buffer, options: { replace?: boolean } = {}): Promise<void> {
    if (value.length > 16_384) return fail("invalid_params", "keychain items hold at most 16 KiB");
    await this.#ensure();
    await invokeHelper(this.#helper, KEYCHAIN_ITEM_CAPABILITIES.store, {
      name: this.nameFor(itemId),
      value: toB64url(value),
      requireAuth: this.#requireAuth,
      replace: options.replace === true,
      reason: "Save a Psyche credential",
    });
  }

  /** Prompts Touch ID / the login password with `reason` when the item requires it. */
  async get(itemId: string, reason: string): Promise<Buffer> {
    const res = await invokeHelper<{ value?: unknown }>(
      this.#helper,
      KEYCHAIN_ITEM_CAPABILITIES.retrieve,
      {
        name: this.nameFor(itemId),
        reason: promptReason(reason),
      },
    );
    if (typeof res.value !== "string") return fail("internal", "helper returned no value");
    return fromB64url(res.value);
  }

  /** Missing items count as removed. */
  async remove(itemId: string): Promise<void> {
    try {
      await invokeHelper(this.#helper, KEYCHAIN_ITEM_CAPABILITIES.deleteItem, {
        name: this.nameFor(itemId),
        reason: "Delete a Psyche credential",
      });
    } catch (err) {
      if ((err as { code?: string }).code !== "not_found") throw err;
    }
  }
}

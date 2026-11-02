import type { NodeClient } from "@psyche/protocol";
import { randomKey } from "../crypto.ts";
import { KeychainItemStore } from "./KeychainItems.ts";

/**
 * Keys for databases that hold *derived* data (the search index; later the memory store): one
 * 32-byte random key per name, kept as a Psyche item in the data-protection keychain through the
 * Mac helper's `keychain.store` with `requireAuth: false`, so it is `whenUnlockedThisDeviceOnly`
 * and reads without Touch ID. This is a separate slot from the vault's own key, which stays
 * behind Touch ID.
 *
 * Threat model: the key never sits next to the database, so a copy of the file, a backup or a
 * cloud sync of the folder is unreadable. It does not protect against code running as the owner
 * on an unlocked Mac, which can ask the keychain for the item like any other app in the
 * access group could.
 */
export class DerivedKeyStore {
  readonly #items: KeychainItemStore;

  constructor(helper: NodeClient, prefix = "psyche.derived.") {
    this.#items = new KeychainItemStore({ helper, prefix, requireAuth: false });
  }

  /** Why the helper cannot hold keys now (not connected, no keychain access), or null. */
  async unavailableReason(): Promise<string | null> {
    try {
      return await this.#items.unavailableReason();
    } catch (err) {
      return err instanceof Error ? err.message : "the Mac helper is not connected";
    }
  }

  /** The key called `name`, made and stored on first use. Throws `unavailable` without a helper. */
  async getOrCreate(name: string): Promise<{ key: Buffer; created: boolean }> {
    const reason = await this.unavailableReason();
    if (reason !== null) throw Object.assign(new Error(reason), { code: "unavailable" });
    try {
      const key = await this.#items.get(name, "Open the search index");
      if (key.length === 32) return { key, created: false };
    } catch (err) {
      if ((err as { code?: string }).code !== "not_found") throw err;
    }
    const key = randomKey();
    await this.#items.put(name, key, { replace: true });
    return { key, created: true };
  }

  async remove(name: string): Promise<void> {
    await this.#items.remove(name);
  }
}

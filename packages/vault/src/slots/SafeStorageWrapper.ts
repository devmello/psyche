import { fail } from "../errors.ts";
import type { KeyWrapper, WrappedKey } from "./KeyWrapper.ts";

/**
 * The few calls the vault needs from Electron's `safeStorage` (async API) or a libsecret
 * binding. The desktop passes an adapter in; the Gateway itself never loads Electron.
 */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): Promise<boolean>;
  /**
   * Linux backend name (`gnome_libsecret`, `kwallet6`, `basic_text`, …); `"os"` on macOS and
   * Windows, where the backend is the Keychain or DPAPI.
   */
  backend(): Promise<string>;
  encrypt(plaintext: Buffer): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<Buffer>;
}

/**
 * `safeStorage` slot (Linux, Windows, server desktop). Refused when the backend is
 * `basic_text`, which "encrypts" with a hard-coded password (security §4.2); use the key-file
 * slot or a passphrase there instead.
 */
export class SafeStorageWrapper implements KeyWrapper {
  readonly slot = "safe_storage" as const;
  readonly #adapter: SafeStorageAdapter;

  constructor(adapter: SafeStorageAdapter) {
    this.#adapter = adapter;
  }

  async unavailableReason(): Promise<string | null> {
    if (!(await this.#adapter.isEncryptionAvailable())) return "safeStorage is not available";
    const backend = await this.#adapter.backend();
    if (backend === "basic_text" || backend === "unknown") {
      return `safeStorage backend ${backend} gives no protection`;
    }
    return null;
  }

  async wrap(dek: Buffer): Promise<WrappedKey> {
    const reason = await this.unavailableReason();
    if (reason !== null) return fail("unavailable", reason);
    const ct = await this.#adapter.encrypt(dek);
    return { kind: "safe_storage", ct: ct.toString("base64") };
  }

  async unwrap(wrapped: WrappedKey): Promise<Buffer> {
    const reason = await this.unavailableReason();
    if (reason !== null) return fail("unavailable", reason);
    if (typeof wrapped.ct !== "string") return fail("invalid_params", "safe_storage slot is empty");
    try {
      return await this.#adapter.decrypt(Buffer.from(wrapped.ct, "base64"));
    } catch {
      return fail("unauthorized", "safeStorage could not decrypt the vault key");
    }
  }
}

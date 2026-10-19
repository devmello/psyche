import type { NodeClient } from "@psyche/protocol";
import { open, randomKey, type SealedBox, seal, zeroize } from "../crypto.ts";
import { fail } from "../errors.ts";
import type { KeyWrapper, UnwrapContext, WrappedKey } from "./KeyWrapper.ts";

/**
 * Access control the mac helper must apply to the key item: Touch ID for the currently enrolled
 * fingers, OR the device passcode. Never `userPresence | biometryCurrentSet` without `.or`,
 * which `SecAccessControlCreateWithFlags` rejects with `errSecParam` (security §4.2, macOS
 * notes KQ7).
 */
export const KEYCHAIN_ACCESS_CONTROL = ["biometryCurrentSet", "or", "devicePasscode"] as const;

/** Mac-helper capabilities this wrapper calls (architecture §6). The agent has no tool for them. */
export const KEYCHAIN_CAPABILITIES = {
  set: "keychain.set",
  unlock: "vault.unlock",
  delete: "keychain.delete",
} as const;

/**
 * `keychain.set` params. The helper stores `value` (base64) as a generic-password item with
 * `kSecUseDataProtectionKeychain`, `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`,
 * non-synchronizable, in its team-prefixed access group, with {@link KEYCHAIN_ACCESS_CONTROL}.
 */
export interface KeychainSetParams {
  service: string;
  account: string;
  value: string;
  accessControl: readonly string[];
  accessible: "whenPasscodeSetThisDeviceOnly";
  synchronizable: false;
  dataProtection: true;
}

/** `vault.unlock` params: read the item, prompting with `reason`; returns `{value}` (base64). */
export interface VaultUnlockParams {
  service: string;
  account: string;
  reason: string;
  /** `LAContext.touchIDAuthenticationAllowableReuseDuration`; 0 for per-fill items. */
  reuseDurationSeconds: number;
}

export interface KeychainWrapperOptions {
  helper: NodeClient;
  service?: string;
  /** One key item per vault; the vault id keeps two homes apart. */
  account: string;
}

/**
 * Keychain slot (macOS default). A random key-encryption key (KEK) lives in the data-protection
 * keychain behind Touch ID; the DEK sealed under it lives in `slots.json`. Reading the KEK goes
 * through the helper's `vault.unlock`, which shows the Touch ID prompt.
 */
export class KeychainWrapper implements KeyWrapper {
  readonly slot = "keychain" as const;
  readonly #helper: NodeClient;
  readonly #service: string;
  readonly #account: string;

  constructor(options: KeychainWrapperOptions) {
    this.#helper = options.helper;
    this.#service = options.service ?? "com.psyche.vault";
    this.#account = options.account;
  }

  async unavailableReason(): Promise<string | null> {
    const caps = await this.#helper.capabilities();
    const names = new Set(caps.map((c) => c.name));
    for (const cap of Object.values(KEYCHAIN_CAPABILITIES)) {
      if (!names.has(cap)) return `helper lacks ${cap}`;
    }
    return null;
  }

  async wrap(dek: Buffer): Promise<WrappedKey> {
    const kek = randomKey();
    try {
      const params: KeychainSetParams = {
        service: this.#service,
        account: this.#account,
        value: kek.toString("base64"),
        accessControl: KEYCHAIN_ACCESS_CONTROL,
        accessible: "whenPasscodeSetThisDeviceOnly",
        synchronizable: false,
        dataProtection: true,
      };
      const res = await this.#helper.invoke(KEYCHAIN_CAPABILITIES.set, params);
      if (!res.ok) return fail("unavailable", `keychain.set failed: ${res.error?.code ?? "error"}`);
      const box = seal(kek, dek, this.#aad());
      return { kind: "keychain", service: this.#service, account: this.#account, ...box };
    } finally {
      zeroize(kek);
    }
  }

  async unwrap(wrapped: WrappedKey, ctx: UnwrapContext): Promise<Buffer> {
    const params: VaultUnlockParams = {
      service: String(wrapped.service ?? this.#service),
      account: String(wrapped.account ?? this.#account),
      reason: ctx.reason,
      reuseDurationSeconds: 0,
    };
    const res = await this.#helper.invoke(KEYCHAIN_CAPABILITIES.unlock, params);
    if (!res.ok) {
      const code = res.error?.code === "cancelled" ? "cancelled" : "unauthorized";
      return fail(code, "keychain unlock was refused or cancelled");
    }
    const value = (res.result as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string") return fail("internal", "helper returned no key");
    const kek = Buffer.from(value, "base64");
    try {
      return open(kek, wrapped as unknown as SealedBox, this.#aad());
    } finally {
      zeroize(kek);
    }
  }

  async destroy(wrapped: WrappedKey): Promise<void> {
    await this.#helper.invoke(KEYCHAIN_CAPABILITIES.delete, {
      service: String(wrapped.service ?? this.#service),
      account: String(wrapped.account ?? this.#account),
    });
  }

  #aad(): string {
    return `psyche.vault.slot.v1|keychain|${this.#service}|${this.#account}`;
  }
}

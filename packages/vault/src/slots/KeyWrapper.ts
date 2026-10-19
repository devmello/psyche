import type { VaultKeySlot } from "@psyche/protocol";

/**
 * One way of protecting the vault's data-encryption key (DEK) at rest (security §4.2). `wrap`
 * returns an opaque, JSON-safe blob that the vault writes to `vault/slots.json`; `unwrap` turns
 * it back into the DEK, prompting the owner where the platform does (Touch ID).
 *
 * A copied `vault.db` plus `slots.json` is useless without what the wrapper holds: the keychain
 * item, the OS safe-storage key, or the key file.
 */
export interface KeyWrapper {
  readonly slot: Exclude<VaultKeySlot, "recovery">;
  /** Why this wrapper cannot be used here (`basic_text` backend, no helper, bad file mode). */
  unavailableReason(): Promise<string | null>;
  wrap(dek: Buffer, options?: WrapOptions): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, ctx: UnwrapContext): Promise<Buffer>;
  /** Remove whatever the wrapper stored outside the blob (the keychain item). */
  destroy?(wrapped: WrappedKey, approvalId?: string): Promise<void>;
}

export interface WrapOptions {
  /** Replace an existing slot (re-wrap after recovery); blobs wrapped before become unopenable. */
  replace?: boolean;
  reason?: string;
}

export interface UnwrapContext {
  /** Shown in the Touch ID / password prompt. */
  reason: string;
}

/** JSON-safe; never contains the DEK in the clear. */
export type WrappedKey = Record<string, string | number | boolean>;

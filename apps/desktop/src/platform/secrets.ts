import { isLinux, type Platform } from "./index.ts";

/**
 * Electron `safeStorage` on Linux (design §10.1). Its backends are `gnome_libsecret`, `kwallet`,
 * `kwallet5`, `kwallet6`, or `basic_text`, which encrypts with a key hard-coded in Chromium: that
 * is obfuscation, not protection. The desktop therefore refuses to store anything under
 * `basic_text`. (The Gateway's vault key does not use `safeStorage` at all: it is a key file, plus
 * the full-disk-encryption check in `disk-encryption.ts`.)
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?: () => string;
  encryptString(plainText: string): Buffer;
}

export type SafeStorageVerdict =
  | { usable: true; backend: string | undefined }
  | { usable: false; reason: "unavailable" | "basic_text"; backend: string | undefined };

/** Only meaningful after the app's `ready` event: Chromium picks the backend then. */
export function safeStorageVerdict(
  storage: SafeStorageLike,
  platform?: Platform,
): SafeStorageVerdict {
  if (!isLinux(platform)) {
    return storage.isEncryptionAvailable()
      ? { usable: true, backend: undefined }
      : { usable: false, reason: "unavailable", backend: undefined };
  }
  const backend = storage.getSelectedStorageBackend?.();
  if (backend === "basic_text") return { usable: false, reason: "basic_text", backend };
  if (!storage.isEncryptionAvailable()) return { usable: false, reason: "unavailable", backend };
  return { usable: true, backend };
}

export class SafeStorageRefused extends Error {
  readonly code = "safe_storage_basic_text";
  constructor() {
    super("The system keyring is not available, so Psyche will not store secrets with safeStorage");
    this.name = "SafeStorageRefused";
  }
}

/**
 * On Linux with the `basic_text` backend: makes `isEncryptionAvailable()` answer false and
 * `encryptString` throw, in place, so every caller (the browser recording key, anything added
 * later) refuses without each one checking the backend. Returns the verdict. Elsewhere it changes
 * nothing.
 */
export function guardSafeStorage(
  storage: SafeStorageLike,
  platform?: Platform,
): SafeStorageVerdict {
  const verdict = safeStorageVerdict(storage, platform);
  if (!verdict.usable && verdict.reason === "basic_text") {
    storage.isEncryptionAvailable = () => false;
    storage.encryptString = () => {
      throw new SafeStorageRefused();
    };
  }
  return verdict;
}

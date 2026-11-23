import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureOwnerOnly } from "./private.ts";

/** The vault key file's place (`ensureVaultKeyFile`), or why there is none. */
export type VaultKeyFile = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The conventional key-file slot: `$PSYCHE_HOME/secrets/vault.key`, 32 random bytes, mode 0600 in a
 * 0700 folder (on Windows an owner-only ACL). It is what the packaged desktop passes as
 * `PSYCHE_VAULT_KEY_FILE`, and what psyched on Linux uses when nothing passes it (no Keychain, no
 * DPAPI). The file is created when missing, but never when the vault already exists with another
 * slot: a new key would not open that slot, and switching slots would lock the owner out. Then
 * nothing is written and `reason` says so. An I/O error (a read-only home) is thrown.
 *
 * The key sits beside the data it protects: the same trade-off as the desktop's key-file slot
 * (security §4.3.1). A copy of the home folder copies the key too.
 */
export function ensureVaultKeyFile(
  psycheHome: string,
  platform: NodeJS.Platform = process.platform,
): VaultKeyFile {
  const keyFile = join(psycheHome, "secrets", "vault.key");
  const slotsFile = join(psycheHome, "vault", "slots.json");
  if (existsSync(slotsFile)) {
    let slots: object | undefined;
    try {
      slots = (JSON.parse(readFileSync(slotsFile, "utf8")) as { slots?: object }).slots;
    } catch {
      return { ok: false, reason: "the vault's slots.json cannot be read" };
    }
    if (!slots || !("key_file" in slots)) {
      const used = Object.keys(slots ?? {});
      return {
        ok: false,
        reason:
          used.length > 0
            ? `the vault uses the ${used.join(", ")} slot; psyched does not switch an existing vault to a key file`
            : "the vault has no key slot; psyched does not switch an existing vault to a key file",
      };
    }
  }
  if (!existsSync(keyFile)) {
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    if (platform === "win32") ensureOwnerOnly(dirname(keyFile), platform);
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  if (platform === "win32") ensureOwnerOnly(keyFile, platform);
  return { ok: true, path: keyFile };
}

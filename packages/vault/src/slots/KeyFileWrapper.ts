import { readFile, stat } from "node:fs/promises";
import { open, type SealedBox, seal, zeroize } from "../crypto.ts";
import { fail } from "../errors.ts";
import type { KeyWrapper, WrappedKey } from "./KeyWrapper.ts";

/**
 * Server mode (security §4.3): a 32-byte key in `PSYCHE_VAULT_KEY_FILE` (raw, hex or base64),
 * mode 0600 or stricter, owned by the Gateway's user. The DEK is sealed under it. Biometric
 * gating is absent in this mode; the UI says so.
 */
export class KeyFileWrapper implements KeyWrapper {
  readonly slot = "key_file" as const;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async unavailableReason(): Promise<string | null> {
    try {
      const st = await stat(this.#path);
      if (!st.isFile()) return "vault key file is not a regular file";
      if ((st.mode & 0o077) !== 0) return "vault key file must be mode 0600";
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        return "vault key file is owned by another user";
      }
      return null;
    } catch {
      return "vault key file is missing";
    }
  }

  async #kek(): Promise<Buffer> {
    const reason = await this.unavailableReason();
    if (reason !== null) return fail("unavailable", reason);
    const raw = await readFile(this.#path);
    let key: Buffer;
    if (raw.length === 32) key = Buffer.from(raw);
    else {
      const text = raw.toString("utf8").trim();
      key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
    }
    zeroize(raw);
    if (key.length !== 32) return fail("invalid_params", "vault key file must hold 32 bytes");
    return key;
  }

  async wrap(dek: Buffer): Promise<WrappedKey> {
    const kek = await this.#kek();
    try {
      return { kind: "key_file", ...seal(kek, dek, "psyche.vault.slot.v1|key_file") };
    } finally {
      zeroize(kek);
    }
  }

  async unwrap(wrapped: WrappedKey): Promise<Buffer> {
    const kek = await this.#kek();
    try {
      return open(kek, wrapped as unknown as SealedBox, "psyche.vault.slot.v1|key_file");
    } finally {
      zeroize(kek);
    }
  }
}

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AnchorSigner, AnchorVerifier } from "./log.ts";
import type { AuditAnchor } from "./store.ts";

/**
 * The server's anchor key (security §15.1: "the mac helper (or the server's device key) signs an
 * anchor"): an Ed25519 key in `$PSYCHE_HOME/security/audit-anchor-key.json`, 0600 in a 0700
 * directory, next to the revocation ledger and outside the backup scope.
 *
 * The file also holds the keyring (every key that ever signed, with the seq it started at) and
 * the head (the last anchored entry). Both live outside `audit/`, so deleting `anchors.jsonl`, or
 * cutting the log's tail together with the anchors past the cut, is reported by `verify`.
 *
 * It is a software key: anyone who can write `security/` can re-sign. The Secure Enclave key in
 * the mac helper is the stronger signer; it plugs in through the same `AnchorSigner` interface.
 * It is not in the vault: anchors are signed unattended while the vault is locked.
 */

export const ANCHOR_KEY_FILE = join("security", "audit-anchor-key.json");

interface KeyringEntry {
  keyId: string;
  /** SPKI DER, base64. */
  publicKey: string;
  /** First entry seq this key anchors. */
  sinceSeq: number;
  createdAt: string;
  kind: "software" | "helper";
}

interface AnchorKeyFile {
  v: 1;
  /** The current software key: PKCS#8 DER, base64. */
  privateKey: string;
  keyId: string;
  keys: KeyringEntry[];
  head?: { seq: number; hash: string };
}

function keyIdOf(spki: Buffer): string {
  return `ed25519:${createHash("sha256").update(spki).digest("hex").slice(0, 16)}`;
}

export class SoftwareAnchorKey implements AnchorSigner, AnchorVerifier {
  readonly path: string;
  readonly keyId: string;
  /** True when this call created the key (the composition root audits that). */
  readonly created: boolean;
  #file: AnchorKeyFile;
  readonly #private: KeyObject;
  readonly #publics = new Map<string, { key: KeyObject; sinceSeq: number }>();

  private constructor(path: string, file: AnchorKeyFile, created: boolean) {
    this.path = path;
    this.#file = file;
    this.created = created;
    this.keyId = file.keyId;
    this.#private = createPrivateKey({
      key: Buffer.from(file.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    for (const k of file.keys) {
      this.#publics.set(k.keyId, {
        key: createPublicKey({
          key: Buffer.from(k.publicKey, "base64"),
          format: "der",
          type: "spki",
        }),
        sinceSeq: k.sinceSeq,
      });
    }
  }

  /**
   * Opens the key under `home`, or creates one that anchors from `nextSeq` on (the seq the next
   * audit entry will get: earlier history was never signed by it).
   */
  static open(
    home: string,
    nextSeq: number,
    now: () => Date = () => new Date(),
  ): SoftwareAnchorKey {
    const path = join(home, ANCHOR_KEY_FILE);
    if (existsSync(path)) {
      const file = JSON.parse(readFileSync(path, "utf8")) as AnchorKeyFile;
      if (file.v !== 1 || typeof file.privateKey !== "string" || !Array.isArray(file.keys)) {
        throw new Error(`${ANCHOR_KEY_FILE} is not a Psyche anchor key file`);
      }
      return new SoftwareAnchorKey(path, file, false);
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const keyId = keyIdOf(spki);
    const file: AnchorKeyFile = {
      v: 1,
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      keyId,
      keys: [
        {
          keyId,
          publicKey: spki.toString("base64"),
          sinceSeq: nextSeq,
          createdAt: now().toISOString(),
          kind: "software",
        },
      ],
    };
    const key = new SoftwareAnchorKey(path, file, true);
    key.#write();
    return key;
  }

  #write(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#file)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  sign(message: string): string {
    return sign(null, Buffer.from(message, "utf8"), this.#private).toString("base64");
  }

  anchored(anchor: AuditAnchor): void {
    this.#file = { ...this.#file, head: { seq: anchor.seq, hash: anchor.hash } };
    this.#write();
  }

  /**
   * After a backup restore the log is legitimately shorter than what this key anchored: forget
   * the head (the caller audits the restore with the head it had). Returns the old head.
   */
  forgetHead(): { seq: number; hash: string } | undefined {
    const old = this.head();
    const { head: _drop, ...rest } = this.#file;
    this.#file = rest;
    this.#write();
    return old;
  }

  verify(keyId: string, message: string, signature: string): boolean {
    const k = this.#publics.get(keyId);
    if (k === undefined) return false;
    try {
      return verify(null, Buffer.from(message, "utf8"), k.key, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }

  signingSinceSeq(): number {
    return Math.min(...this.#file.keys.map((k) => k.sinceSeq));
  }

  head(): { seq: number; hash: string } | undefined {
    return this.#file.head === undefined ? undefined : { ...this.#file.head };
  }

  /** The keyring's public part, for `audit.verify` reports and the CLI. */
  keys(): { keyId: string; sinceSeq: number; kind: KeyringEntry["kind"]; createdAt: string }[] {
    return this.#file.keys.map(({ keyId, sinceSeq, kind, createdAt }) => ({
      keyId,
      sinceSeq,
      kind,
      createdAt,
    }));
  }
}

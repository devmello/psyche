import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type BundleSigner as BundleSignerStatusInfo,
  PsycheError,
  type SkillAuthor,
} from "@psyche/protocol";
import { type BundleAuthor, type BundleSigningKey, keyIdOf } from "./bundle.ts";

/**
 * The owner's author key and the keys they have met (docs/design/shared-bundles-2026.md
 * sections 4 and 5). No central authority: trust is per key, on the owner's say-so.
 *
 * - `$PSYCHE_HOME/identity/author.key`: an Ed25519 key made on the first export, in the same
 *   format and with the same modes as the Gateway identity key (directory 0700, file 0600,
 *   created with a link so two exports cannot make two keys). Only the Gateway process reads
 *   it; it is never sent anywhere, never in a bundle, never in the vault or backup scope.
 * - `$PSYCHE_HOME/skills/authors.json` (0600, next to the lock file, outside the workspace the
 *   agent can write): keys seen on imported bundles, which of them the owner trusts or revoked.
 */
interface AuthorKeyFile {
  v: 1;
  name: string;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string; d: string };
}

export const AUTHOR_KEY_FILE = join("identity", "author.key");
export const AUTHORS_FILE = "authors.json";
const MAX_NAME = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for them
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

/** A display name an author may sign with: plain text, no controls or direction overrides. */
export function cleanAuthorName(name: string): string {
  const n = name.normalize("NFC").trim();
  if (n === "" || n.length > MAX_NAME || BAD_NAME_CHARS.test(n))
    throw new PsycheError(
      "invalid_params",
      `the author name must be 1-${MAX_NAME} plain characters`,
    );
  return n;
}

function isKeyFile(v: unknown): v is AuthorKeyFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Partial<AuthorKeyFile>;
  return (
    f.v === 1 &&
    typeof f.name === "string" &&
    f.jwk?.kty === "OKP" &&
    f.jwk.crv === "Ed25519" &&
    typeof f.jwk.x === "string" &&
    typeof f.jwk.d === "string"
  );
}

function signerFrom(file: AuthorKeyFile): BundleSigningKey {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: file.jwk, format: "jwk" });
  } catch {
    throw new PsycheError("internal", "identity/author.key: the key is invalid");
  }
  if (createPublicKey(key).export({ format: "jwk" }).x !== file.jwk.x)
    throw new PsycheError("internal", "identity/author.key: public key does not match the private");
  const author: BundleAuthor = {
    name: file.name,
    keyId: keyIdOf(file.jwk.x),
    publicKey: file.jwk.x,
  };
  return { author, sign: (data) => sign(null, data, key).toString("base64url") };
}

export class AuthorKeyStore {
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, AUTHOR_KEY_FILE);
  }

  /** The public half, without creating a key. */
  peek(): { keyId: string; name: string; publicKey: string } | undefined {
    const f = this.#read();
    return f === undefined
      ? undefined
      : { keyId: keyIdOf(f.jwk.x), name: f.name, publicKey: f.jwk.x };
  }

  /** The signer, creating the key (named `name`) on first use. */
  loadOrCreate(name: string): { signer: BundleSigningKey; created: boolean } {
    const existing = this.#read();
    if (existing !== undefined) return { signer: signerFrom(existing), created: false };
    const file = this.#create(cleanAuthorName(name));
    return { signer: signerFrom(file), created: file.created };
  }

  #read(): AuthorKeyFile | undefined {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    // A file that exists but is not a key is an error, never a fresh key: replacing the author
    // key must be loud, because every reader who trusted it would then see a changed key.
    if (!isKeyFile(parsed))
      throw new PsycheError(
        "internal",
        `${this.path} is not an author key; refusing to replace it`,
      );
    chmodSync(this.path, 0o600);
    return parsed;
  }

  #create(name: string): AuthorKeyFile & { created: boolean } {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    if (typeof jwk.x !== "string" || typeof jwk.d !== "string")
      throw new PsycheError("internal", "ed25519 jwk export failed");
    const file: AuthorKeyFile = {
      v: 1,
      name,
      jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
    };
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      rmSync(tmp, { force: true });
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(file)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(tmp, this.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          // Another export won the race: its key is the key.
          const winner = this.#read();
          if (winner !== undefined) return { ...winner, created: false };
        }
        throw err;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
    return { ...file, created: true };
  }
}

// --- Keys the owner has met ----------------------------------------------------------------------

type AuthorState = SkillAuthor["state"];

interface AuthorRecord {
  keyId: string;
  publicKey: string;
  /** Names this key has signed under (the author's claims). */
  names: string[];
  state: AuthorState;
  firstSeen: string;
  trustedAt?: string;
}

interface AuthorsFile {
  v: 1;
  authors: Record<string, AuthorRecord>;
}

const MAX_AUTHORS = 500;

export class AuthorRing {
  readonly path: string;
  #now: () => number;

  constructor(skillsDir: string, now: () => number = Date.now) {
    this.path = join(skillsDir, AUTHORS_FILE);
    this.#now = now;
  }

  #read(): AuthorsFile {
    if (!existsSync(this.path)) return { v: 1, authors: {} };
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      data = undefined;
    }
    const f = data as AuthorsFile | undefined;
    // A corrupt file trusts nothing and is never silently rewritten.
    if (f?.v !== 1 || typeof f.authors !== "object" || f.authors === null)
      throw new PsycheError("internal", `cannot read ${AUTHORS_FILE}`);
    return f;
  }

  #write(f: AuthorsFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  get(keyId: string): AuthorRecord | undefined {
    const r = this.#read().authors[keyId];
    return r === undefined ? undefined : structuredClone(r);
  }

  list(): SkillAuthor[] {
    return Object.values(this.#read().authors)
      .sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0))
      .map(toAuthor);
  }

  /** Other keys that have signed under `name` (case-insensitive). */
  keysForName(name: string): string[] {
    const n = name.toLowerCase();
    return Object.values(this.#read().authors)
      .filter((a) => a.names.some((x) => x.toLowerCase() === n))
      .map((a) => a.keyId);
  }

  /** Records a key seen on an approved install; trust is a separate, explicit step. */
  observe(author: BundleAuthor): AuthorRecord {
    const f = this.#read();
    let r = f.authors[author.keyId];
    if (r === undefined) {
      if (Object.keys(f.authors).length >= MAX_AUTHORS)
        throw new PsycheError("conflict", "too many author keys; revoke or remove some first");
      r = {
        keyId: author.keyId,
        publicKey: author.publicKey,
        names: [author.name],
        state: "seen",
        firstSeen: new Date(this.#now()).toISOString(),
      };
      f.authors[author.keyId] = r;
    } else if (!r.names.includes(author.name) && r.names.length < 8) {
      r.names.push(author.name);
    }
    this.#write(f);
    return structuredClone(r);
  }

  /** Sets a seen key's state. A key never seen cannot be trusted by id alone. */
  setState(keyId: string, state: AuthorState): SkillAuthor {
    const f = this.#read();
    let r = f.authors[keyId];
    if (r === undefined) {
      // A key can be revoked before it is ever met (a warning arrived out of band); it cannot be
      // trusted unseen.
      if (state !== "revoked") throw new PsycheError("not_found", "no such author key");
      if (Object.keys(f.authors).length >= MAX_AUTHORS)
        throw new PsycheError("conflict", "too many author keys");
      r = {
        keyId,
        publicKey: "",
        names: [],
        state,
        firstSeen: new Date(this.#now()).toISOString(),
      };
      f.authors[keyId] = r;
    }
    r.state = state;
    if (state === "trusted") r.trustedAt = new Date(this.#now()).toISOString();
    else delete r.trustedAt;
    this.#write(f);
    return toAuthor(r);
  }

  /**
   * How a signed bundle looks to this owner. `installed` is the key the same skill was
   * installed with (`null` when it was installed unsigned), `undefined` for a first install.
   */
  statusOf(
    signer: BundleAuthor,
    own: { keyId: string } | undefined,
    installed: { keyId: string } | null | undefined,
  ): BundleSignerStatusInfo {
    const base = { keyId: signer.keyId, name: signer.name };
    const rec = this.get(signer.keyId);
    const signerChanged = installed != null && installed.keyId !== signer.keyId;
    if (rec?.state === "revoked") return { ...base, status: "revoked", signerChanged };
    if (own?.keyId === signer.keyId) return { ...base, status: "own", signerChanged: false };
    const others = this.keysForName(signer.name).filter((k) => k !== signer.keyId);
    if (rec?.state === "trusted" && !signerChanged)
      return { ...base, status: "trusted", signerChanged };
    if (signerChanged || (rec === undefined && others.length > 0)) {
      const previousKeyId = installed?.keyId ?? others[0];
      return {
        ...base,
        status: "changed",
        ...(previousKeyId === undefined ? {} : { previousKeyId }),
        signerChanged,
      };
    }
    return { ...base, status: rec === undefined ? "new" : "seen", signerChanged };
  }

  /** Keys the owner revoked, for installed skills signed by one. */
  isRevoked(keyId: string): boolean {
    return this.#read().authors[keyId]?.state === "revoked";
  }
}

function toAuthor(r: AuthorRecord): SkillAuthor {
  return {
    keyId: r.keyId,
    names: [...r.names],
    state: r.state,
    firstSeen: r.firstSeen,
    ...(r.trustedAt === undefined ? {} : { trustedAt: r.trustedAt }),
  };
}

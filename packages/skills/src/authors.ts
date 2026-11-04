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
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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

/** Letters that look like Latin ones, for the comparison skeleton (not exhaustive). */
const CONFUSABLES: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  һ: "h",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  к: "k",
  м: "m",
  н: "h",
  т: "t",
  в: "b",
  ο: "o",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  β: "b",
  η: "n",
  μ: "u",
  ѵ: "v",
  "0": "o",
  "1": "l",
  "|": "l",
  "5": "s",
  "3": "e",
  "!": "l",
  i: "l",
  j: "l",
  $: "s",
  "@": "a",
};

/** Normalized for comparison: NFKC, case-folded, trimmed, whitespace collapsed. */
export function normalizeAuthorName(name: string): string {
  return name
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .replace(/[\s\u200b-\u200f\ufeff]+/g, " ")
    .trim();
}

/**
 * A confusable skeleton: diacritics dropped, look-alike letters and digits mapped to one Latin
 * form, everything that is not a letter or digit removed. "Ad\u0430 Lovelace", "ada  lovelace"
 * and "4da L0velace" share a skeleton with "Ada Lovelace".
 */
export function authorNameSkeleton(name: string): string {
  const base = normalizeAuthorName(name)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  let out = "";
  for (const ch of base) {
    const m = CONFUSABLES[ch] ?? ch;
    if (/[\p{L}\p{N}]/u.test(m)) out += m;
  }
  return out;
}

/** Opens the author key without following a link, and checks the owner and the mode. */
function readKeyText(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP")
      throw new PsycheError("internal", `${path} is a link; refusing to read it as the author key`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile())
      throw new PsycheError("internal", `${path} is not a regular file; refusing to read it`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      throw new PsycheError("internal", `${path} is not owned by this user; refusing to read it`);
    if ((st.mode & 0o077) !== 0)
      throw new PsycheError(
        "internal",
        `${path} is readable by others (chmod 600 it); refusing to use it`,
      );
    const buf = Buffer.alloc(Math.min(st.size, 65_536));
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
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

  /** The signer, creating the key (named `name`, which is then required) on first use. */
  loadOrCreate(name: string | undefined): { signer: BundleSigningKey; created: boolean } {
    const existing = this.#read();
    if (existing !== undefined) return { signer: signerFrom(existing), created: false };
    if (name === undefined || name.trim() === "")
      throw new PsycheError(
        "invalid_params",
        "Choose the name to sign your skills with; everyone who imports them sees it",
      );
    const file = this.#create(cleanAuthorName(name));
    return { signer: signerFrom(file), created: file.created };
  }

  #read(): AuthorKeyFile | undefined {
    const dir = dirname(this.path);
    try {
      if (lstatSync(dir).isSymbolicLink())
        throw new PsycheError(
          "internal",
          `${dir} is a link; refusing to use it for the author key`,
        );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const text = readKeyText(this.path);
    if (text === undefined) return undefined;
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
    // A leftover of ours is removed; the new file is created exclusively, never through a link.
    rmSync(tmp, { force: true });
    writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600, flag: "wx" });
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
    const n = authorNameSkeleton(name);
    return Object.values(this.#read().authors)
      .filter((a) => a.names.some((x) => authorNameSkeleton(x) === n))
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
    own: { keyId: string; name: string } | undefined,
    installed: { keyId: string } | null | undefined,
  ): BundleSignerStatusInfo {
    const base = { keyId: signer.keyId, name: signer.name };
    const rec = this.get(signer.keyId);
    const signerChanged = installed != null && installed.keyId !== signer.keyId;
    if (rec?.state === "revoked") return { ...base, status: "revoked", signerChanged };
    if (own?.keyId === signer.keyId) return { ...base, status: "own", signerChanged: false };
    // A look-alike of the owner's own name with another key is the worst impersonation.
    const impersonates =
      own !== undefined && authorNameSkeleton(own.name) === authorNameSkeleton(signer.name);
    const others = this.keysForName(signer.name).filter((k) => k !== signer.keyId);
    if (rec?.state === "trusted" && !signerChanged && !impersonates) {
      const seenName = rec.names.some(
        (n) => authorNameSkeleton(n) === authorNameSkeleton(signer.name),
      );
      return {
        ...base,
        status: "trusted",
        signerChanged,
        ...(seenName ? {} : { nameChanged: true }),
      };
    }
    if (signerChanged || impersonates || (rec === undefined && others.length > 0)) {
      const previousKeyId = installed?.keyId ?? (impersonates ? own?.keyId : others[0]);
      return {
        ...base,
        status: "changed",
        ...(previousKeyId === undefined ? {} : { previousKeyId }),
        signerChanged,
        ...(impersonates ? { impersonates: true } : {}),
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

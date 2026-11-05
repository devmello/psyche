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
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type BundleSigner as BundleSignerStatusInfo,
  PsycheError,
  type SkillAuthor,
} from "@psyche/protocol";
import { type BundleAuthor, type BundleSigningKey, keyIdOf } from "./bundle-core.ts";
import { authorNameSkeleton } from "./confusables.ts";
import type { VerifiedNotice } from "./notice.ts";
import {
  MAX_ROTATIONS,
  parseRotationChain,
  type RotationStatement,
  signRotation,
} from "./rotation.ts";

export { authorNameSkeleton, normalizeAuthorName } from "./confusables.ts";

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
/** The statements the owner's old keys signed naming their successors (public, 0600). */
export const AUTHOR_ROTATION_FILE = join("identity", "author.rotation.json");
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

/**
 * The author key file cannot be used as it is. A plain, actionable error (not `internal`): the
 * owner can fix the file, and nothing but signing and the owner-name check depends on it.
 */
function unsafeKey(reason: string): PsycheError {
  return new PsycheError(
    "conflict",
    `the author key file has unsafe permissions or is not a plain key file (${reason}); fix it or move it away`,
  );
}

/** Opens the author key without following a link, and checks the owner and the mode. */
function readKeyText(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw unsafeKey(`${path} is a link`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw unsafeKey(`${path} is not a regular file`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      throw unsafeKey(`${path} is not owned by this user`);
    if ((st.mode & 0o077) !== 0)
      throw unsafeKey(`${path} is readable by others (run chmod 600 on it)`);
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
  readonly rotationPath: string;

  constructor(home: string) {
    this.path = join(home, AUTHOR_KEY_FILE);
    this.rotationPath = join(home, AUTHOR_ROTATION_FILE);
  }

  /**
   * The rotation statements that lead to the current key (oldest first), for the bundles it
   * signs. Empty when the key was never rotated. A statement that does not lead here is ignored.
   */
  chain(): RotationStatement[] {
    const current = this.peek();
    if (current === undefined) return [];
    const all = this.#statements();
    const out: RotationStatement[] = [];
    let want = current.keyId;
    for (let i = 0; i < MAX_ROTATIONS; i++) {
      const s = all.find((x) => x.to.keyId === want);
      if (s === undefined) break;
      out.unshift(s);
      want = s.from.keyId;
    }
    return out;
  }

  /** Every key this owner retired by rotating: bundles signed by one are still the owner's own. */
  retiredKeyIds(): string[] {
    return [...new Set(this.#statements().map((s) => s.from.keyId))];
  }

  /**
   * Replaces the author key with a new one (same name), with a statement signed by the old key
   * naming the new one. The old private key is dropped: nothing else needs it, and a retired
   * key kept on disk is only a liability. Everything here is synchronous, so two rotations
   * cannot interleave. The owner's gate (Host shell, presence) is the caller's.
   */
  rotate(now: Date): { from: BundleAuthor; to: BundleAuthor; statement: RotationStatement } {
    const existing = this.#read();
    if (existing === undefined)
      throw new PsycheError("conflict", "there is no author key to rotate yet");
    const old = signerFrom(existing);
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    if (typeof jwk.x !== "string" || typeof jwk.d !== "string")
      throw new PsycheError("internal", "ed25519 jwk export failed");
    const file: AuthorKeyFile = {
      v: 1,
      name: existing.name,
      jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
    };
    const to: BundleAuthor = { name: file.name, keyId: keyIdOf(jwk.x), publicKey: jwk.x };
    const statement = signRotation(old, to, now.toISOString());
    const history = [...this.#statements(), statement].slice(-32);
    // The statement first: if the key swap fails, an unused statement leads nowhere and is ignored.
    this.#replaceFile(
      this.rotationPath,
      `${JSON.stringify({ v: 1, statements: history }, null, 2)}\n`,
    );
    this.#replaceFile(this.path, `${JSON.stringify(file)}\n`);
    return { from: old.author, to, statement };
  }

  #statements(): RotationStatement[] {
    let text: string | undefined;
    try {
      text = readKeyText(this.rotationPath);
    } catch {
      return [];
    }
    if (text === undefined) return [];
    try {
      const f = JSON.parse(text) as { v?: unknown; statements?: unknown };
      return f.v === 1 && Array.isArray(f.statements)
        ? f.statements.flatMap((s) => {
            try {
              return parseRotationChain([s]);
            } catch {
              return [];
            }
          })
        : [];
    } catch {
      return [];
    }
  }

  /** Atomically replaces a 0600 file in the 0700 identity directory (exclusive temp file). */
  #replaceFile(path: string, text: string): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      rmSync(tmp, { force: true });
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      // The rename itself reaches the disk too.
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } finally {
      rmSync(tmp, { force: true });
    }
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
      if (lstatSync(dir).isSymbolicLink()) throw unsafeKey(`${dir} is a link`);
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
      throw unsafeKey(`${this.path} is not an author key; it is not replaced`);
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

/** What an older file kept per bundle hash: one record. */
interface RevokedBundle {
  keyId: string;
  reason: string;
  at: string;
}

/** One author's notice about a bundle; a hash can have several, none replacing another. */
interface RevokedBundleEntry extends RevokedBundle {
  /** The notice signer and the earlier keys its chain named. */
  lineage: string[];
}

/** What one `observe` added, filled in by it so `rollback` can take out exactly that. */
export interface RingUndo {
  /** The key record it made, when it made one. */
  key?: string;
  /** The (from, to) rotation pairs it added. */
  pairs: [string, string][];
}

interface AuthorsFile {
  v: 1;
  authors: Record<string, AuthorRecord>;
  /** Bundles signed notices marked bad, by bundle hash (append-only per hash). */
  bundles?: Record<string, RevokedBundleEntry[]>;
  /** Rotations seen on approved installs: a key, and the keys that claimed to replace it. */
  rotations?: Record<string, string[]>;
}

// Notice records have caps of their own, so they can never stop a key from being recorded.
const MAX_REVOKED_BUNDLES = 1000;
/** Notices about one bundle: a few per lineage (so one author cannot crowd out another), and a ceiling. */
const MAX_NOTICES_PER_ROOT = 3;
const MAX_NOTICES_PER_BUNDLE = 64;
const MAX_REVOKED_UNSEEN = 1000;
const MAX_ROTATIONS_KEPT = 2000;

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
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(f, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    // The rename reaches the disk too.
    const dfd = openSync(dirname(this.path), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }

  /**
   * Undoes what one `observe` did (as told by the `undo` it filled in), where that is safe: a key
   * it made is forgotten only while it is still exactly what `observe` made (seen, never trusted
   * or revoked in between), and only the rotations it added are taken out, one pair at a time, so
   * what another install recorded is never touched.
   */
  rollback(undo: RingUndo): void {
    const f = this.#read();
    if (undo.key !== undefined) {
      const now = f.authors[undo.key];
      if (now?.state === "seen" && now.trustedAt === undefined) delete f.authors[undo.key];
    }
    if (f.rotations !== undefined) {
      for (const [from, to] of undo.pairs) {
        const list = (f.rotations[from] ?? []).filter((k) => k !== to);
        if (list.length === 0) delete f.rotations[from];
        else f.rotations[from] = list;
      }
    }
    this.#write(f);
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

  /** A key the owner has actually met (seen on a bundle), not just named in a revocation. */
  #met(f: AuthorsFile, keyId: string): boolean {
    const r = f.authors[keyId];
    return r !== undefined && r.publicKey !== "";
  }

  /**
   * Records a key seen on an approved install; trust is a separate, explicit step. `ancestors`
   * (the rotation chain the file carried, nearest first) is remembered as "this key was replaced
   * by that one", so a later second successor of the same key is seen as a fork and a key that
   * has been replaced is known to be retired.
   */
  observe(author: BundleAuthor, ancestors: readonly string[] = [], undo?: RingUndo): AuthorRecord {
    const f = this.#read();
    let r = f.authors[author.keyId];
    if (r === undefined || r.publicKey === "") {
      // Revocation placeholders (keys named in a notice) have their own cap and never count here.
      const met = Object.values(f.authors).filter((a) => a.publicKey !== "").length;
      if (met >= MAX_AUTHORS)
        throw new PsycheError("conflict", "too many author keys; revoke or remove some first");
      if (r === undefined) {
        r = {
          keyId: author.keyId,
          publicKey: author.publicKey,
          names: [author.name],
          state: "seen",
          firstSeen: new Date(this.#now()).toISOString(),
        };
        f.authors[author.keyId] = r;
        if (undo !== undefined) undo.key = author.keyId;
      } else {
        r.publicKey = author.publicKey;
        if (!r.names.includes(author.name)) r.names.push(author.name);
      }
    } else if (!r.names.includes(author.name) && r.names.length < 8) {
      r.names.push(author.name);
    }
    const rotations = f.rotations ?? {};
    let to = author.keyId;
    for (const from of ancestors) {
      const list = rotations[from] ?? [];
      if (
        !list.includes(to) &&
        list.length < 4 &&
        Object.keys(rotations).length < MAX_ROTATIONS_KEPT
      ) {
        rotations[from] = [...list, to];
        undo?.pairs.push([from, to]);
      }
      to = from;
    }
    if (ancestors.length > 0) f.rotations = rotations;
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
      if (Object.values(f.authors).filter((a) => a.publicKey === "").length >= MAX_REVOKED_UNSEEN)
        throw new PsycheError("conflict", "too many revoked keys");
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
   * The earlier keys of a rotation chain that still vouch for the signer, nearest first: the chain
   * is followed up from the signer and stops at the first key that was revoked, because a revoked
   * key's word (that it named its successor) is no longer taken. Revoking an old key therefore
   * never revokes its successors; they just stop being explained by it.
   */
  vouching(ancestors: readonly string[]): string[] {
    const f = this.#read();
    const out: string[] = [];
    for (const k of ancestors) {
      if (f.authors[k]?.state === "revoked") break;
      out.push(k);
    }
    return out;
  }

  /** Whether this key was replaced by a rotation the owner has seen. */
  isRetired(keyId: string): boolean {
    return (this.#read().rotations?.[keyId]?.length ?? 0) > 0;
  }

  /**
   * Two different successors of one key is a fork (a stolen old key minting a competing
   * successor, or a mistake): refused until the owner revokes one of them.
   */
  assertNoFork(signerKeyId: string, ancestors: readonly string[]): void {
    const rotations = this.#read().rotations ?? {};
    let to = signerKeyId;
    for (const from of ancestors) {
      const known = rotations[from] ?? [];
      if (known.length > 0 && !known.includes(to) && known.some((k) => !this.isRevoked(k)))
        throw new PsycheError(
          "policy_denied",
          "two different keys claim to replace the same earlier key; revoke the one you do not trust first",
          { details: { keyId: from } },
        );
      to = from;
    }
  }

  /**
   * How a signed bundle looks to this owner. `installed` is the key the same skill was
   * installed with (`null` when it was installed unsigned), `undefined` for a first install.
   * Rotation chains only vouch up to the first revoked key (`vouching`), and a key the owner
   * retired by rotating is "own" but never `verified`.
   */
  statusOf(
    signer: BundleAuthor,
    own: { keyId: string; name: string } | undefined,
    installed: { keyId: string } | null | undefined,
    lineage: { ancestors?: readonly string[]; ownRetired?: readonly string[] } = {},
  ): BundleSignerStatusInfo {
    const base = { keyId: signer.keyId, name: signer.name };
    const f = this.#read();
    const vouch = this.vouching(lineage.ancestors ?? []);
    const rec = f.authors[signer.keyId];
    // A chain that names the installed key explains the new one: not a change of signer.
    const signerChanged =
      installed != null && installed.keyId !== signer.keyId && !vouch.includes(installed.keyId);
    // Revoked comes before everything, the owner's own retired keys included.
    if (rec?.state === "revoked") return { ...base, status: "revoked", signerChanged };
    if (own?.keyId === signer.keyId) return { ...base, status: "own", signerChanged: false };
    if (lineage.ownRetired?.includes(signer.keyId) === true)
      return { ...base, status: "own", retired: true, signerChanged: false };
    const retired = (f.rotations?.[signer.keyId]?.length ?? 0) > 0 ? { retired: true } : {};
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
        ...retired,
        ...(seenName ? {} : { nameChanged: true }),
      };
    }
    // Same author, new key: an earlier key the owner has met (or installed this with) signed a
    // statement naming this one. That explains the change; it does not trust the new key.
    if (!impersonates) {
      for (const k of vouch) {
        const earlier = f.authors[k];
        if (earlier === undefined && installed?.keyId !== k) continue;
        return {
          ...base,
          status: "rotated",
          previousKeyId: k,
          rotatedFrom: { keyId: k, state: earlier?.state ?? "seen" },
          signerChanged,
          ...retired,
        };
      }
    }
    if (signerChanged || impersonates || (rec === undefined && others.length > 0)) {
      const previousKeyId = installed?.keyId ?? (impersonates ? own?.keyId : others[0]);
      return {
        ...base,
        status: "changed",
        ...(previousKeyId === undefined ? {} : { previousKeyId }),
        signerChanged,
        ...retired,
        ...(impersonates ? { impersonates: true } : {}),
      };
    }
    return { ...base, status: rec === undefined ? "new" : "seen", signerChanged, ...retired };
  }

  /**
   * What importing this notice would do, without doing it: the same checks as `applyNotice`
   * (they throw the same errors), and the names the owner knows the key by.
   */
  previewNotice(v: VerifiedNotice): { names: string[]; alreadyRevoked: boolean } {
    const f = this.#read();
    this.#checkNotice(f, v);
    const rec = f.authors[v.notice.keyId];
    return {
      names: rec?.names ?? [],
      alreadyRevoked:
        v.notice.kind === "key"
          ? rec?.state === "revoked"
          : this.#entries(f, v.notice.bundleHash as string).some((e) => e.keyId === v.notice.keyId),
    };
  }

  #checkNotice(f: AuthorsFile, v: VerifiedNotice, trustedLocal = false): void {
    const lineage = [v.notice.signer.keyId, ...v.ancestors];
    if (!trustedLocal && !lineage.some((k) => this.#met(f, k)))
      throw new PsycheError(
        "policy_denied",
        "that notice is signed by an author you have not met, so it is not applied",
        { details: { keyId: v.notice.signer.keyId } },
      );
    if (!lineage.includes(v.notice.keyId))
      throw new PsycheError(
        "policy_denied",
        "a notice can only revoke its signer's own keys or bundles",
        { details: { keyId: v.notice.keyId } },
      );
  }

  #entries(f: AuthorsFile, hash: string): RevokedBundleEntry[] {
    const v = f.bundles?.[hash] as RevokedBundleEntry[] | RevokedBundle | undefined;
    if (v === undefined) return [];
    // An older file kept one record per hash.
    return Array.isArray(v) ? v : [{ ...v, lineage: [v.keyId] }];
  }

  /**
   * Applies a verified revocation notice. It must come from a key the owner has met (or from a
   * successor of one, by the rotation chain it carries), and it can only revoke that key's own
   * lineage or a bundle that lineage signed. Revoking is the safe direction, so it needs no
   * presence; a notice from a stranger, or about somebody else's key, is refused. Bundle notices
   * are kept as a set per hash: one author's notice never replaces another's.
   * `trustedLocal` is for the owner's own notices, made on this Mac.
   */
  applyNotice(
    v: VerifiedNotice,
    opts: { trustedLocal?: boolean } = {},
  ): { kind: "key" | "bundle"; keyId: string; bundleHash?: string } {
    const f0 = this.#read();
    this.#checkNotice(f0, v, opts.trustedLocal === true);
    if (v.notice.kind === "key") {
      this.setState(v.notice.keyId, "revoked");
      return { kind: "key", keyId: v.notice.keyId };
    }
    const hash = v.notice.bundleHash as string;
    const f = this.#read();
    const bundles = f.bundles ?? {};
    const entries = this.#entries(f, hash);
    const mine = entries.find((e) => e.keyId === v.notice.keyId);
    if (mine === undefined) {
      const lineage = [v.notice.signer.keyId, ...v.ancestors];
      const root = lineage[lineage.length - 1];
      // Each lineage root has a quota of its own, and the owner's own notices are never refused.
      if (
        opts.trustedLocal !== true &&
        (entries.length >= MAX_NOTICES_PER_BUNDLE ||
          entries.filter((e) => e.lineage[e.lineage.length - 1] === root).length >=
            MAX_NOTICES_PER_ROOT ||
          (bundles[hash] === undefined && Object.keys(bundles).length >= MAX_REVOKED_BUNDLES))
      )
        throw new PsycheError("conflict", "too many notices about this bundle");
      entries.push({
        keyId: v.notice.keyId,
        lineage,
        reason: v.notice.reason,
        at: new Date(this.#now()).toISOString(),
      });
    }
    bundles[hash] = entries;
    f.bundles = bundles;
    this.#write(f);
    return { kind: "bundle", keyId: v.notice.keyId, bundleHash: hash };
  }

  /**
   * Whether a signed notice marked this bundle bad. A notice counts only when its signer's
   * lineage contains the key that actually signed the bundle, so an author cannot block somebody
   * else's bundle by naming its hash. An unsigned bundle is never matched.
   */
  isBundleRevoked(bundleHash: string, signerKeyId: string | undefined): boolean {
    if (signerKeyId === undefined) return false;
    return this.#entries(this.#read(), bundleHash).some(
      (e) => e.keyId === signerKeyId && e.lineage.includes(signerKeyId),
    );
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

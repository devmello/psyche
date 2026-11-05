import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { restrictToOwner } from "@psyche/hostfs";
import {
  type BrowserTeachStep,
  PsycheError,
  sanitizeTeachSteps,
  teachStepIssues,
  teachText,
} from "@psyche/protocol";

/**
 * Recordings the owner chose to keep (teach by showing, design doc §5). By default a recording is
 * never written anywhere: it lives in the desktop app's memory from Stop until the owner saves a
 * skill or discards it, and is then gone. Only "Keep this recording on this Mac" writes a file
 * here, and what it writes is the reviewed step list after `sanitizeTeachSteps`: no sensitive
 * value (there never was one), no typed example the owner did not choose to keep, no query
 * strings.
 *
 * Where: `$PSYCHE_HOME/state/teach/`, not the Library. `state/` is Psyche's own: no agent file tool
 * reaches it (the prohibitions deny it by name), `files.read` serves only the Library, and the
 * backup leaves it out. The folder is `0700` and the files `0600`.
 *
 * Signed: each file carries an HMAC-SHA256 over its id and contents, made with a key that lives
 * outside `$PSYCHE_HOME` (the app's user-data folder). A file that is unsigned, edited or dropped
 * in from elsewhere is not listed and not opened. Files expire after 90 days and at most 20 are
 * kept. Reads refuse links (`O_NOFOLLOW`, `lstat`), cap the size, and pick fields explicitly.
 *
 * Encrypted at rest: with a per-install key (sealed by the OS keychain, kept beside the signing
 * key) each file is AES-256-GCM, bound to its id, so the folder shows no step names, addresses or
 * kept values and a file edited, swapped or renamed fails to open. GCM already authenticates the
 * file, so the format has no separate MAC. Files written by the older, signed-but-plain format
 * are verified and re-written encrypted the first time the store is used. Without a keychain
 * (`enc: null`) nothing new is kept at all: a plain copy of the owner's steps on disk is the
 * worse outcome, and a recording is cheap to make again.
 *
 * Only the desktop app's main process opens this store. It has no tool, no Gateway method and no
 * bridge command, so the agent cannot list, read or write a kept recording.
 */
export interface KeptRecording {
  id: string;
  title: string;
  /** Epoch ms. */
  keptAt: number;
  steps: BrowserTeachStep[];
}

export const KEPT_RECORDING_LIMIT = 20;
export const KEPT_RECORDING_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 512 * 1024;
const ID = /^teach_[a-z0-9]{8,32}$/;

/** Wraps the key before it is written, with the OS keychain (Electron `safeStorage`). */
export interface TeachKeySeal {
  seal(key: Buffer): Buffer;
  open(sealed: Buffer): Buffer;
}

/**
 * The signing key: 32 random bytes, made on first use and kept outside the store's folder. With a
 * `seal` (the desktop passes `safeStorage`) the file holds only the wrapped key, useless without
 * the keychain. The file is opened with `O_NOFOLLOW` and created with `O_EXCL` (`0600`). A file
 * that is the wrong size or cannot be opened is an error, never a quiet new key: a new key would
 * orphan every kept recording and hide that something replaced the file.
 */
/**
 * Windows has no modes, so `0600` / `0700` there is a DACL for this user only (children of a
 * folder inherit it). Throws when Windows will not apply it.
 */
function privateOnWindows(path: string): void {
  if (process.platform === "win32" && !restrictToOwner(path)) {
    throw new PsycheError("internal", "the recordings cannot be made private to this user");
  }
}

export function loadTeachKey(
  path: string,
  wrap?: TeachKeySeal,
  options: { adoptPlain?: boolean | (() => boolean) } = {},
): Buffer {
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw new PsycheError("internal", "the recording key cannot be read");
  }
  if (st !== undefined) {
    if (!st.isFile() || st.size > 4096)
      throw new PsycheError("internal", "the recording key file is not a plain file");
    let raw: Buffer;
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        raw = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      throw new PsycheError("internal", "the recording key cannot be read");
    }
    // `adoptPlain`, for the signing key only: the first version wrote it unwrapped, as 32 raw
    // bytes (a wrapped one is longer). Keep that key, so files signed with it still verify, and
    // wrap it now. The encryption key never does this: a raw file there is an error, so a planted
    // file cannot choose the key.
    // It happens once: the caller says whether it may (no marker yet, no encrypted file yet), and
    // the temporary file is created exclusively without following a link.
    const mayAdopt =
      typeof options.adoptPlain === "function" ? options.adoptPlain() : options.adoptPlain === true;
    if (mayAdopt && wrap !== undefined && raw.length === 32) {
      const tmp = `${path}.tmp`;
      rmSync(tmp, { force: true });
      const out = openSync(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        privateOnWindows(tmp);
        writeFileSync(out, wrap.seal(raw));
      } finally {
        closeSync(out);
      }
      renameSync(tmp, path);
      return raw;
    }
    let key: Buffer;
    try {
      key = wrap === undefined ? raw : wrap.open(raw);
    } catch {
      throw new PsycheError("internal", "the recording key cannot be opened");
    }
    if (key.length !== 32)
      throw new PsycheError("internal", "the recording key has the wrong size");
    return key;
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    privateOnWindows(path);
    writeFileSync(fd, wrap === undefined ? key : wrap.seal(key));
  } finally {
    closeSync(fd);
  }
  return key;
}

interface Signed {
  v: 1;
  mac: string;
  rec: KeptRecording;
}

/** The encrypted file: nothing but the nonce, the tag and the ciphertext is readable. */
interface Sealed {
  v: 2;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ct: string;
}

type EncKey = Buffer | (() => Buffer);

export interface TeachStoreOptions {
  /**
   * The encryption key (32 bytes, or a function that makes it on first use). `null`: no keychain,
   * so nothing new is kept (see `canKeep`). Absent: the older signed-but-plain format (tests only;
   * the desktop always passes one of the two).
   */
  enc?: EncKey | null;
  /** A kept file that was ignored, and why in one line (no content). */
  log?: (message: string) => void;
  /**
   * Called once the older signed files have been dealt with (migrated, or left because they do not
   * verify). The signing key is of no further use then: the desktop deletes it.
   */
  onMigrated?: () => void;
}

/** Whether the folder already holds an encrypted file (sync; for the one-time key adoption). */
export function hasEncryptedRecordings(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const st = lstatSync(join(dir, n));
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      if ((JSON.parse(readFileSync(join(dir, n), "utf8")) as { v?: unknown })?.v === 2) return true;
    } catch {
      // not a readable file of ours
    }
  }
  return false;
}

export class TeachKeptStore {
  readonly dir: string;
  #key: Buffer | (() => Buffer);
  #now: () => number;
  #enc: EncKey | null | undefined;
  #log: (message: string) => void;
  #migrated: Promise<void> | undefined;
  #migratedOnce: (() => void) | undefined;
  #done = false;

  /** `key` may be a function, so the key file is made only when a recording is first kept or read. */
  constructor(
    dir: string,
    key: Buffer | (() => Buffer),
    now: () => number = Date.now,
    options: TeachStoreOptions = {},
  ) {
    this.dir = dir;
    this.#key = key;
    this.#now = now;
    this.#enc = options.enc;
    this.#log = options.log ?? (() => {});
    this.#migratedOnce = options.onMigrated;
  }

  /**
   * Opens the key now and says whether a recording can be kept. A keychain that is there but will
   * not open the key (locked, a different login) is the same as none, and is remembered.
   */
  async probe(): Promise<boolean> {
    if (this.#enc === null || this.#enc === undefined) return this.canKeep;
    try {
      this.#encKey();
    } catch {
      // #encKey has already logged it and switched keeping off.
    }
    return this.canKeep;
  }

  /** Whether a new recording can be kept: false without a keychain (nothing plain is written). */
  get canKeep(): boolean {
    return this.#enc !== null;
  }

  /** `encrypted`, `unavailable` (no keychain: nothing is kept) or `plain` (tests only). */
  get mode(): "encrypted" | "unavailable" | "plain" {
    return this.#enc === null ? "unavailable" : this.#enc === undefined ? "plain" : "encrypted";
  }

  #encKey(): Buffer {
    if (this.#enc === null || this.#enc === undefined)
      throw new PsycheError("unavailable", "recordings cannot be encrypted on this Mac");
    if (typeof this.#enc === "function") {
      try {
        this.#enc = this.#enc();
      } catch (err) {
        // Once is enough: no more attempts, nothing new is kept, and the files stay unread.
        this.#enc = null;
        this.#log(
          `kept recordings: the encryption key cannot be opened (${err instanceof Error ? err.message : "error"})`,
        );
        throw new PsycheError("unavailable", "recordings cannot be encrypted on this Mac");
      }
    }
    if (this.#enc.length !== 32)
      throw new PsycheError("internal", "the encryption key has the wrong size");
    return this.#enc;
  }

  #aad(id: string): Buffer {
    return Buffer.from(`psyche.teach.v2\n${id}`);
  }

  #seal(rec: KeptRecording): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#encKey(), iv);
    c.setAAD(this.#aad(rec.id));
    const ct = Buffer.concat([c.update(JSON.stringify(rec), "utf8"), c.final()]);
    return {
      v: 2,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
  }

  #unseal(id: string, f: Sealed): KeptRecording | undefined {
    if (
      f.alg !== "aes-256-gcm" ||
      typeof f.iv !== "string" ||
      typeof f.tag !== "string" ||
      typeof f.ct !== "string"
    )
      return undefined;
    const iv = Buffer.from(f.iv, "base64");
    const tag = Buffer.from(f.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) return undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", this.#encKey(), iv);
      d.setAAD(this.#aad(id));
      d.setAuthTag(tag);
      const text = Buffer.concat([d.update(Buffer.from(f.ct, "base64")), d.final()]).toString(
        "utf8",
      );
      return JSON.parse(text) as KeptRecording;
    } catch {
      return undefined;
    }
  }

  async #write(file: string, body: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    privateOnWindows(this.dir);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  }

  /**
   * First use: a signed plain file from the older format is checked and re-written encrypted. A
   * file that does not verify is left alone (and never listed). Once per store.
   */
  #ready(): Promise<void> {
    this.#migrated ??= this.#migrate().catch((err) => {
      this.#log(`kept recordings: could not migrate (${err instanceof Error ? err.message : err})`);
    });
    return this.#migrated;
  }

  async #migrate(): Promise<void> {
    if (this.#enc === null || this.#enc === undefined) return;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      const id = n.replace(/\.json$/, "");
      if (!n.endsWith(".json") || !ID.test(id)) continue;
      const parsed = await this.#read(id);
      if (parsed === undefined || parsed.v !== 1) continue;
      let rec: KeptRecording | undefined;
      try {
        rec = this.#verifySigned(id, parsed as Signed);
      } catch {
        rec = undefined;
      }
      if (rec === undefined) {
        this.#log(`kept recording ${id}: ignored (the signature does not match)`);
        continue;
      }
      await this.#write(this.#file(id), this.#seal(rec));
    }
    // Nothing plain is read from here on, and the signing key is not needed again.
    this.#done = true;
    this.#migratedOnce?.();
  }

  /** The file's parsed JSON, or `undefined` for a link, a huge file or one that is not JSON. */
  async #read(id: string): Promise<{ v?: unknown } | undefined> {
    const file = this.#file(id);
    let raw: string;
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
      const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        raw = await fh.readFile("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      return undefined;
    }
    try {
      const j = JSON.parse(raw) as unknown;
      return typeof j === "object" && j !== null ? (j as { v?: unknown }) : undefined;
    } catch {
      return undefined;
    }
  }

  #verifySigned(id: string, signed: Signed): KeptRecording | undefined {
    const r = signed?.rec;
    if (
      signed?.v !== 1 ||
      typeof signed.mac !== "string" ||
      typeof r !== "object" ||
      r === null ||
      r.id !== id
    )
      return undefined;
    const mine = Buffer.from(this.#mac(r), "hex");
    const theirs = Buffer.from(signed.mac, "hex");
    if (mine.length !== theirs.length || !timingSafeEqual(mine, theirs)) return undefined;
    return r;
  }

  #secret(): Buffer {
    if (typeof this.#key === "function") this.#key = this.#key();
    if (this.#key.length < 16)
      throw new PsycheError("invalid_params", "the signing key is too short");
    return this.#key;
  }

  #file(id: string): string {
    if (!ID.test(id)) throw new PsycheError("invalid_params", "not a recording id");
    return join(this.dir, `${id}.json`);
  }

  #mac(rec: KeptRecording): string {
    return createHmac("sha256", this.#secret())
      .update(`psyche.teach.v1\n${rec.id}\n${JSON.stringify(rec)}`)
      .digest("hex");
  }

  async keep(
    id: string,
    title: string,
    steps: readonly BrowserTeachStep[],
  ): Promise<KeptRecording> {
    const file = this.#file(id);
    if (!this.canKeep)
      throw new PsycheError(
        "unavailable",
        "recordings are not kept on this Mac: the keychain is not available to encrypt them",
      );
    await this.#ready();
    const clean = sanitizeTeachSteps(steps);
    const issues = teachStepIssues(clean);
    if (issues.length > 0) throw new PsycheError("invalid_params", issues.join("; "));
    const existing = await this.list();
    if (existing.length >= KEPT_RECORDING_LIMIT && !existing.some((r) => r.id === id))
      throw new PsycheError("conflict", `at most ${KEPT_RECORDING_LIMIT} kept recordings`);
    const rec: KeptRecording = {
      id,
      title: teachText(title, 120),
      keptAt: this.#now(),
      steps: clean,
    };
    await this.#write(
      file,
      this.#enc === undefined
        ? ({ v: 1, mac: this.#mac(rec), rec } satisfies Signed)
        : this.#seal(rec),
    );
    return rec;
  }

  /** A decryptable (or signed), unexpired file of the right shape; anything else is `undefined`. */
  async get(id: string): Promise<KeptRecording | undefined> {
    const file = this.#file(id);
    await this.#ready();
    const parsed = await this.#read(id);
    if (parsed === undefined) return undefined;
    let r: KeptRecording | undefined;
    try {
      if (parsed.v === 2) {
        r =
          this.#enc === null || this.#enc === undefined
            ? undefined
            : this.#unseal(id, parsed as Sealed);
        if (r === undefined) {
          this.#log(`kept recording ${id}: ignored (wrong key, edited or not readable)`);
          return undefined;
        }
      } else if (parsed.v === 1) {
        // With a keychain the plain files were re-written when the store opened, and the ones
        // left did not verify: a plain file is never read again. Without one it is still read if
        // its signature holds.
        if (this.#done) {
          this.#log(`kept recording ${id}: ignored (plain files are not read after migration)`);
          return undefined;
        }
        r = this.#verifySigned(id, parsed as Signed);
        if (r === undefined) {
          this.#log(`kept recording ${id}: ignored (the signature does not match)`);
          return undefined;
        }
      }
    } catch (err) {
      this.#log(`kept recording ${id}: ignored (${err instanceof Error ? err.message : "error"})`);
      return undefined;
    }
    if (
      r === undefined ||
      r === null ||
      typeof r !== "object" ||
      r.id !== id ||
      typeof r.title !== "string" ||
      typeof r.keptAt !== "number" ||
      !Array.isArray(r.steps)
    )
      return undefined;
    if (this.#now() - r.keptAt > KEPT_RECORDING_TTL_MS) {
      await rm(file, { force: true });
      return undefined;
    }
    // Fields picked one by one, and cleaned again on the way out.
    return {
      id: r.id,
      title: teachText(r.title, 120),
      keptAt: r.keptAt,
      steps: sanitizeTeachSteps(r.steps),
    };
  }

  async list(): Promise<KeptRecording[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: KeptRecording[] = [];
    for (const n of names) {
      const id = n.replace(/\.json$/, "");
      if (!n.endsWith(".json") || !ID.test(id)) continue;
      const rec = await this.get(id);
      if (rec !== undefined) out.push(rec);
    }
    return out.sort((a, b) => b.keptAt - a.keptAt);
  }

  async delete(id: string): Promise<void> {
    await rm(this.#file(id), { force: true });
  }
}

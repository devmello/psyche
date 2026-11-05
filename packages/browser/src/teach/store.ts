import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
export function loadTeachKey(path: string, wrap?: TeachKeySeal): Buffer {
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

export class TeachKeptStore {
  readonly dir: string;
  #key: Buffer | (() => Buffer);
  #now: () => number;

  /** `key` may be a function, so the key file is made only when a recording is first kept or read. */
  constructor(dir: string, key: Buffer | (() => Buffer), now: () => number = Date.now) {
    this.dir = dir;
    this.#key = key;
    this.#now = now;
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
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const signed: Signed = { v: 1, mac: this.#mac(rec), rec };
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(signed)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    return rec;
  }

  /** A signed, unexpired, plain file of the right shape; anything else is `undefined`. */
  async get(id: string): Promise<KeptRecording | undefined> {
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
    let signed: Signed;
    try {
      signed = JSON.parse(raw) as Signed;
    } catch {
      return undefined;
    }
    const r = signed?.rec;
    if (
      signed?.v !== 1 ||
      typeof signed.mac !== "string" ||
      typeof r !== "object" ||
      r === null ||
      r.id !== id ||
      typeof r.title !== "string" ||
      typeof r.keptAt !== "number" ||
      !Array.isArray(r.steps)
    )
      return undefined;
    const mine = Buffer.from(this.#mac(r), "hex");
    const theirs = Buffer.from(signed.mac, "hex");
    if (mine.length !== theirs.length || !timingSafeEqual(mine, theirs)) return undefined;
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

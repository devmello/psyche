import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { PsycheError } from "@psyche/protocol";
import { Decrypter, Encrypter } from "age-encryption";

/**
 * Backups (feature U4; architecture §12; security §14): `state/` (with channel sessions in
 * `state/channels/`), `workspace/`, `vault/`, `library/`, plus `config.json` and `audit/`, in a
 * gzip'd tar with a SHA-256 manifest, encrypted with age. The device key in `cli/`, sockets in
 * `run/`, logs, browser profiles, sandbox workspaces and VM disks are not included.
 *
 * Restoring on another machine needs the vault recovery key: the keychain slot does not travel.
 */

export const BACKUP_ENTRIES = [
  "config.json",
  "state",
  "workspace",
  "vault",
  "library",
  "audit",
] as const;
export const MANIFEST = "psyche-backup.json";
const FORMAT = "psyche-backup";

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  format: typeof FORMAT;
  version: 1;
  createdAt: string;
  cliVersion: string;
  entries: string[];
  files: ManifestFile[];
}

export type Encryption =
  | { kind: "passphrase"; passphrase: string; scryptLogN?: number }
  | { kind: "recipients"; recipients: string[] }
  | { kind: "none" };

export type Decryption =
  | { kind: "passphrase"; passphrase: string }
  | { kind: "identities"; identities: string[] }
  | { kind: "none" };

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

function listFiles(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return; // never follow links out of $PSYCHE_HOME
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) listFiles(root, join(rel, name), out);
  } else if (st.isFile()) {
    out.push(rel);
  }
}

export async function buildManifest(
  home: string,
  cliVersion: string,
  now: Date,
): Promise<Manifest> {
  const entries = BACKUP_ENTRIES.filter((e) => existsSync(join(home, e)));
  if (!entries.includes("state")) {
    throw new PsycheError("not_found", `${home} has no state/ directory; nothing to back up`);
  }
  const paths: string[] = [];
  for (const e of entries) listFiles(home, e, paths);
  const files: ManifestFile[] = [];
  for (const p of paths) {
    const abs = join(home, p);
    files.push({
      path: p.split(sep).join("/"),
      size: lstatSync(abs).size,
      sha256: await sha256File(abs),
    });
  }
  return { format: FORMAT, version: 1, createdAt: now.toISOString(), cliVersion, entries, files };
}

function tarProcess(args: string[], cwd?: string) {
  // No shell; COPYFILE_DISABLE keeps macOS tar from adding AppleDouble ._ files.
  return spawn("tar", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

function waitExit(child: ReturnType<typeof spawn>, what: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  return new Promise((resolve, reject) => {
    child.on("error", (err) => reject(new PsycheError("internal", `${what}: ${err.message}`)));
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new PsycheError("internal", `${what} failed (exit ${code}): ${stderr.trim()}`)),
    );
  });
}

export interface CreateOptions {
  now?: Date;
  /**
   * Consistent copies of files that are live while the Gateway runs, keyed by home-relative path
   * (`state/psyche.sqlite`). Each writes its snapshot to `dest` (the Gateway uses SQLite's
   * online backup API). The live file and its `-wal`, `-shm` and `-journal` siblings are left out.
   */
  snapshots?: Readonly<Record<string, (dest: string) => Promise<void>>>;
}

const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

/**
 * Mirrors `rel` from `home` into `tree` with hard links (copies across filesystems), so the
 * archive is built from a fixed set of files while the originals keep changing.
 */
function stageTree(home: string, tree: string, rel: string, skip: ReadonlySet<string>): void {
  const src = join(home, rel);
  const st = lstatSync(src);
  if (st.isSymbolicLink()) return; // never follow links out of $PSYCHE_HOME
  const dest = join(tree, rel);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(src).sort()) stageTree(home, tree, join(rel, name), skip);
    return;
  }
  if (!st.isFile() || skip.has(rel.split(sep).join("/"))) return;
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

/**
 * Writes an encrypted backup of `home` to `out` (0600). Without `snapshots` the files must be
 * quiescent (the CLI stops the Gateway); with them the Gateway keeps running.
 */
export async function createBackup(
  home: string,
  out: string,
  enc: Encryption,
  producer: string,
  opts: CreateOptions = {},
): Promise<Manifest> {
  const entries = BACKUP_ENTRIES.filter((e) => existsSync(join(home, e)));
  if (!entries.includes("state")) {
    throw new PsycheError("not_found", `${home} has no state/ directory; nothing to back up`);
  }
  const snapshots = opts.snapshots ?? {};
  const skip = new Set<string>();
  for (const rel of Object.keys(snapshots)) {
    skip.add(rel);
    for (const suffix of SQLITE_SIDECARS) skip.add(`${rel}${suffix}`);
  }
  // Staging lives inside $PSYCHE_HOME (0700, same filesystem, so hard links work).
  const stage = mkdtempSync(join(home, ".psyche-backup-"));
  const tree = join(stage, "tree");
  const tmpOut = `${out}.partial`;
  try {
    chmodSync(stage, 0o700);
    mkdirSync(tree, { mode: 0o700 });
    for (const e of entries) stageTree(home, tree, e, skip);
    for (const [rel, write] of Object.entries(snapshots)) {
      const dest = join(tree, rel);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      await write(dest);
    }
    const manifest = await buildManifest(tree, producer, opts.now ?? new Date());
    writeFileSync(join(tree, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const tar = tarProcess(["-cf", "-", "-C", tree, MANIFEST, ...manifest.entries]);
    const exited = waitExit(tar, "tar");
    const gzip = createGzip();
    tar.stdout.on("error", (err) => gzip.destroy(err));
    const gz = Readable.toWeb(tar.stdout.pipe(gzip)) as ReadableStream<Uint8Array>;
    let body: ReadableStream<Uint8Array> = gz;
    if (enc.kind !== "none") {
      const e = new Encrypter();
      if (enc.kind === "passphrase") {
        e.setPassphrase(enc.passphrase);
        if (enc.scryptLogN) e.setScryptWorkFactor(enc.scryptLogN);
      } else {
        for (const r of enc.recipients) e.addRecipient(r);
      }
      body = await e.encrypt(gz);
    }
    // Await both together: a tar failure must reject here, not as an unhandled rejection.
    const [, tarErr] = await Promise.all([
      pipeline(Readable.fromWeb(body as never), createWriteStream(tmpOut, { mode: 0o600 })),
      exited.then(
        () => null,
        (err: unknown) => err,
      ),
    ]);
    if (tarErr) throw tarErr;
    renameSync(tmpOut, out);
    chmodSync(out, 0o600);
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tmpOut, { force: true });
  }
}

/** The decrypted (still gzip'd) archive. Errors (a bad tag mid-file) surface through the pipeline. */
async function plaintextStream(file: string, dec: Decryption): Promise<Readable> {
  const raw = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  let body: ReadableStream<Uint8Array> = raw;
  if (dec.kind !== "none") {
    const d = new Decrypter();
    if (dec.kind === "passphrase") d.addPassphrase(dec.passphrase);
    else for (const i of dec.identities) d.addIdentity(i);
    try {
      body = await d.decrypt(raw);
    } catch (err) {
      throw new PsycheError(
        "invalid_params",
        `Cannot decrypt ${file}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return Readable.fromWeb(body as never);
}

const ENTRY_SET = new Set<string>(BACKUP_ENTRIES);

/**
 * The manifest comes from the archive, so it is untrusted until checked: entries must be known
 * top-level names (never `..` or a path), and every file must sit under one of them. Otherwise a
 * crafted archive could make restore rename files outside `$PSYCHE_HOME`.
 */
export function parseManifest(text: string, file: string): Manifest {
  let m: Manifest;
  try {
    m = JSON.parse(text) as Manifest;
  } catch {
    throw new PsycheError("invalid_params", `${file}: unreadable manifest`);
  }
  if (m?.format !== FORMAT || m.version !== 1) {
    throw new PsycheError("invalid_params", `${file}: unsupported backup format`);
  }
  const bad = (why: string) =>
    new PsycheError("invalid_params", `${file}: invalid manifest (${why})`);
  if (!Array.isArray(m.entries) || !Array.isArray(m.files)) throw bad("entries/files");
  if (new Set(m.entries).size !== m.entries.length) throw bad("duplicate entries");
  for (const e of m.entries) {
    if (typeof e !== "string" || !ENTRY_SET.has(e)) throw bad(`unknown entry ${JSON.stringify(e)}`);
  }
  for (const f of m.files) {
    const parts = typeof f?.path === "string" ? f.path.split("/") : [];
    if (
      parts.length === 0 ||
      f.path.startsWith("/") ||
      f.path.includes("\\") ||
      parts.some((p) => p === "" || p === "." || p === "..") ||
      !m.entries.includes(parts[0] as string) ||
      typeof f.sha256 !== "string"
    ) {
      throw bad(`file path ${JSON.stringify(f?.path)}`);
    }
  }
  return m;
}

/** Extracts into a fresh directory next to `near` and checks every hash. */
export async function extractAndVerify(
  file: string,
  dec: Decryption,
  near: string,
): Promise<{ dir: string; manifest: Manifest; problems: string[] }> {
  mkdirSync(near, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(near, ".psyche-restore-"));
  chmodSync(dir, 0o700);
  try {
    // Decrypt and decompress the whole archive into a 0600 file first, then extract it. Nothing
    // is extracted before age has authenticated every chunk, and tar never sees a pipe it may
    // close early (GNU tar stops reading at the end-of-archive marker: "Premature close").
    const plain = `${dir}.tar`;
    try {
      try {
        await pipeline(
          await plaintextStream(file, dec),
          createGunzip(),
          createWriteStream(plain, { mode: 0o600 }),
        );
      } catch (err) {
        throw new PsycheError(
          "invalid_params",
          `${file} is damaged or the key is wrong: ${err instanceof Error ? err.message : err}`,
        );
      }
      const tar = tarProcess(["-xf", plain, "-C", dir]);
      tar.stdin.end();
      await waitExit(tar, "tar -x");
    } finally {
      rmSync(plain, { force: true });
    }
    const manifestPath = join(dir, MANIFEST);
    if (!existsSync(manifestPath))
      throw new PsycheError("invalid_params", `${file} is not a Psyche backup (no ${MANIFEST})`);
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"), file);
    const problems: string[] = [];
    const listed = new Set<string>();
    for (const f of manifest.files) {
      listed.add(f.path);
      const abs = join(dir, f.path);
      if (!existsSync(abs)) problems.push(`${f.path}: missing`);
      else if ((await sha256File(abs)) !== f.sha256) problems.push(`${f.path}: hash mismatch`);
    }
    const present: string[] = [];
    for (const e of manifest.entries) {
      if (existsSync(join(dir, e))) listFiles(dir, e, present);
      else problems.push(`${e}: listed but missing`);
    }
    for (const p of present) {
      const rel = p.split(sep).join("/");
      if (!listed.has(rel)) problems.push(`${rel}: not in the manifest`);
    }
    return { dir, manifest, problems };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export async function verifyBackup(
  file: string,
  dec: Decryption,
  scratch: string,
): Promise<{ manifest: Manifest; problems: string[] }> {
  const { dir, manifest, problems } = await extractAndVerify(file, dec, scratch);
  rmSync(dir, { recursive: true, force: true });
  return { manifest, problems };
}

/** Owner-only modes on everything restored (security §14). */
function tighten(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) tighten(join(path, name));
  } else chmodSync(path, 0o600);
}

/**
 * Restores into `home`. Existing entries are moved aside to `home/.pre-restore-<ts>/` when
 * `force` is set; otherwise a non-empty target is refused.
 */
export async function restoreBackup(
  file: string,
  dec: Decryption,
  home: string,
  opts: { force: boolean; now?: Date },
): Promise<{ manifest: Manifest; movedAside: string | null }> {
  const clashes = BACKUP_ENTRIES.filter((e) => existsSync(join(home, e)));
  if (clashes.length && !opts.force) {
    throw new PsycheError(
      "conflict",
      `${home} already has ${clashes.join(", ")}; move them aside first (psyche backup restore --force)`,
    );
  }
  const { dir, manifest, problems } = await extractAndVerify(file, dec, home);
  try {
    if (problems.length) {
      throw new PsycheError(
        "invalid_params",
        `Backup failed verification: ${problems.slice(0, 5).join("; ")}`,
        { details: { problems } },
      );
    }
    let movedAside: string | null = null;
    const moved: string[] = [];
    const placed: string[] = [];
    try {
      if (clashes.length) {
        movedAside = join(
          home,
          `.pre-restore-${(opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}`,
        );
        mkdirSync(movedAside, { mode: 0o700 });
        for (const e of clashes) {
          renameSync(join(home, e), join(movedAside, e));
          moved.push(e);
        }
      }
      for (const e of manifest.entries) {
        renameSync(join(dir, e), join(home, e));
        placed.push(e);
        tighten(join(home, e));
      }
    } catch (err) {
      // Roll back: take out what was placed, put the previous state back.
      for (const e of placed) renameSync(join(home, e), join(dir, `${e}.failed`));
      for (const e of moved) renameSync(join(movedAside as string, e), join(home, e));
      if (movedAside) rmSync(movedAside, { recursive: true, force: true });
      throw err;
    }
    chmodSync(home, 0o700);
    return { manifest, movedAside: movedAside ? relative(home, movedAside) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

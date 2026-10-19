import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
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
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { Decrypter, Encrypter } from "age-encryption";
import { CliError } from "./errors.ts";

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
    throw new CliError("failure", `${home} has no state/ directory; nothing to back up`);
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
    child.on("error", (err) => reject(new CliError("failure", `${what}: ${err.message}`)));
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new CliError("failure", `${what} failed (exit ${code}): ${stderr.trim()}`)),
    );
  });
}

/** Writes an encrypted backup of `home` to `out` (0600). The Gateway must not be running. */
export async function createBackup(
  home: string,
  out: string,
  enc: Encryption,
  cliVersion: string,
  now = new Date(),
): Promise<Manifest> {
  const manifest = await buildManifest(home, cliVersion, now);
  const stage = mkdtempSync(join(dirname(out), ".psyche-backup-"));
  const tmpOut = `${out}.partial`;
  try {
    chmodSync(stage, 0o700);
    writeFileSync(join(stage, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const tar = tarProcess(["-cf", "-", "-C", stage, MANIFEST, "-C", home, ...manifest.entries]);
    const exited = waitExit(tar, "tar");
    const gz = Readable.toWeb(tar.stdout.pipe(createGzip())) as ReadableStream<Uint8Array>;
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
    await pipeline(Readable.fromWeb(body as never), createWriteStream(tmpOut, { mode: 0o600 }));
    await exited;
    renameSync(tmpOut, out);
    chmodSync(out, 0o600);
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tmpOut, { force: true });
  }
}

async function plaintextStream(file: string, dec: Decryption): Promise<NodeJS.ReadableStream> {
  const raw = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  let body: ReadableStream<Uint8Array> = raw;
  if (dec.kind !== "none") {
    const d = new Decrypter();
    if (dec.kind === "passphrase") d.addPassphrase(dec.passphrase);
    else for (const i of dec.identities) d.addIdentity(i);
    try {
      body = await d.decrypt(raw);
    } catch (err) {
      throw new CliError(
        "failure",
        `Cannot decrypt ${file}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return Readable.fromWeb(body as never).pipe(createGunzip());
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
    const input = await plaintextStream(file, dec);
    const tar = tarProcess(["-xf", "-", "-C", dir]);
    const exited = waitExit(tar, "tar -x");
    await pipeline(input, tar.stdin as Writable);
    await exited;
    const manifestPath = join(dir, MANIFEST);
    if (!existsSync(manifestPath))
      throw new CliError("failure", `${file} is not a Psyche backup (no ${MANIFEST})`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.format !== FORMAT || manifest.version !== 1) {
      throw new CliError("failure", `${file}: unsupported backup format`);
    }
    const problems: string[] = [];
    const listed = new Set<string>();
    for (const f of manifest.files) {
      listed.add(f.path);
      const abs = join(dir, f.path);
      if (!abs.startsWith(dir + sep)) {
        problems.push(`${f.path}: path escapes the archive`);
        continue;
      }
      if (!existsSync(abs)) problems.push(`${f.path}: missing`);
      else if ((await sha256File(abs)) !== f.sha256) problems.push(`${f.path}: hash mismatch`);
    }
    const present: string[] = [];
    for (const e of manifest.entries) if (existsSync(join(dir, e))) listFiles(dir, e, present);
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
    throw new CliError(
      "failure",
      `${home} already has ${clashes.join(", ")}; pass --force to move them aside first`,
    );
  }
  const { dir, manifest, problems } = await extractAndVerify(file, dec, home);
  try {
    if (problems.length) {
      throw new CliError(
        "failure",
        `Backup failed verification: ${problems.slice(0, 5).join("; ")}`,
        { problems },
      );
    }
    let movedAside: string | null = null;
    if (clashes.length) {
      movedAside = join(
        home,
        `.pre-restore-${(opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-")}`,
      );
      mkdirSync(movedAside, { mode: 0o700 });
      for (const e of clashes) renameSync(join(home, e), join(movedAside, e));
    }
    for (const e of manifest.entries) {
      renameSync(join(dir, e), join(home, e));
      tighten(join(home, e));
    }
    chmodSync(home, 0o700);
    return { manifest, movedAside: movedAside ? relative(home, movedAside) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

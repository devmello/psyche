import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { InstallKind, ManifestArtifact } from "../main/update-manifest.ts";
import type { UpdateGateway } from "./linux-gateway.ts";
import type { LinuxUpdatePaths, RunCommand } from "./linux-install.ts";

/**
 * The Linux apply step (docs/design/linux-desktop-2026.md §3.3, §3.4): what happens after the
 * updater has downloaded an artifact and checked it against the signed manifest.
 *
 * - AppImage: copy the running image aside, stop the Gateway, `rename()` the new image over
 *   `$APPIMAGE` (atomic on one filesystem; a copy beside the target and a rename otherwise), start
 *   the Gateway, relaunch. The old inode stays mounted for processes still using it.
 * - deb and rpm: `pkexec apt-get install` / `dnf install` on the verified file, after the Gateway
 *   is stopped. The package manager's refusal is returned with its message; the app stays put.
 *
 * Rollback keeps the artifact that was running (`previous.json` plus the file) and swaps it back,
 * with the data snapshot restore and the skip-list entry supplied by the caller.
 *
 * Everything is injected (fs, process runner, Gateway, relaunch), so the tests run on any OS with
 * a fake `pkexec`. The file is re-hashed right before it is used: the download sat in the owner's
 * cache folder, and a same-user process could have touched it in between.
 */

/** What the updater leaves behind for the apply step. */
export interface StagedUpdate {
  release: string;
  /** The downloaded file, in `updatesDir`. */
  file: string;
  artifact: ManifestArtifact;
}

/** The running copy, for `previous.json` and the skip-list entry. */
export interface RunningBuild {
  version: string;
  /** `build` of the bundled `psyched/build-info.json`. */
  build?: string | undefined;
}

export type ApplyFailure =
  | "hash_mismatch"
  | "missing_file"
  | "swap_failed"
  | "package_manager_failed"
  | "no_previous";

export type ApplyResult =
  | { state: "applied"; release: string }
  /** Nothing was changed; the owner finishes by hand ("Download the update"). */
  | { state: "manual"; reason: "not_writable" | "no_package_manager"; file: string }
  /** The admin prompt was dismissed. Nothing changed. */
  | { state: "cancelled" }
  | { state: "failed"; code: ApplyFailure; detail: string };

export interface ApplyFs {
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<unknown>;
  copyFile(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, opts: { force: true }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<void>;
  readFile(path: string): Promise<string>;
  /** Rejects when the access is not allowed or the path does not exist. */
  access(path: string, mode: number): Promise<void>;
  hash(path: string): Promise<{ sha256: string; bytes: number }>;
}

export const nodeApplyFs: ApplyFs = {
  mkdir: (p, o) => mkdir(p, o),
  copyFile: (a, b) => copyFile(a, b),
  rename: (a, b) => rename(a, b),
  rm: (p, o) => rm(p, o),
  chmod: (p, m) => chmod(p, m),
  writeFile: (p, d, o) => writeFile(p, d, o),
  readFile: (p) => readFile(p, "utf8"),
  access: (p, m) => access(p, m),
  hash: (p) =>
    new Promise((resolve, reject) => {
      const h = createHash("sha256");
      let bytes = 0;
      createReadStream(p)
        .on("data", (c) => {
          h.update(c);
          bytes += c.length;
        })
        .on("error", reject)
        .on("end", () => resolve({ sha256: h.digest("hex"), bytes }));
    }),
};

export interface ApplyDeps {
  fs: ApplyFs;
  run: RunCommand;
  gateway: UpdateGateway;
  /** Relaunch the desktop from the (new) install and quit this process. */
  relaunch(): void;
  paths: LinuxUpdatePaths;
  current: RunningBuild;
  log(message: string): void;
}

/** What `previous.json` and `installed.json` hold. */
export interface ArtifactRecord {
  version: string;
  build?: string | undefined;
  kind: InstallKind;
  /** File name inside the record's folder. */
  file: string;
  sha256: string;
  bytes: number;
  savedAt: string;
}

const RECORD_FILE = "previous.json";
const INSTALLED_FILE = "installed.json";
const PKEXEC = "/usr/bin/pkexec";

const fail = (code: ApplyFailure, detail: string): ApplyResult => ({
  state: "failed",
  code,
  detail,
});

async function exists(fs: ApplyFs, path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(fs: ApplyFs, file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function readRecord(fs: ApplyFs, file: string): Promise<ArtifactRecord | undefined> {
  try {
    const r = JSON.parse(await fs.readFile(file)) as Partial<ArtifactRecord>;
    if (
      typeof r.version === "string" &&
      typeof r.file === "string" &&
      /^[A-Za-z0-9._-]+$/.test(r.file) &&
      typeof r.sha256 === "string" &&
      Number.isInteger(r.bytes) &&
      (r.kind === "appimage" || r.kind === "deb" || r.kind === "rpm")
    ) {
      return r as ArtifactRecord;
    }
  } catch {
    // missing or damaged: no record
  }
  return undefined;
}

/** The file on disk is byte-for-byte what the manifest vouched for; removes it when it is not. */
async function verifyStaged(fs: ApplyFs, staged: StagedUpdate): Promise<ApplyResult | undefined> {
  if (!(await exists(fs, staged.file))) {
    return fail("missing_file", `${basename(staged.file)} is no longer in the update folder`);
  }
  const { sha256, bytes } = await fs.hash(staged.file);
  if (sha256 !== staged.artifact.sha256 || bytes !== staged.artifact.bytes) {
    await fs.rm(staged.file, { force: true });
    return fail("hash_mismatch", `${staged.artifact.name} changed after it was verified`);
  }
  return undefined;
}

/** `rename(from, to)`; across filesystems, a copy beside `to` and a rename (still atomic for `to`). */
async function replaceFile(fs: ApplyFs, from: string, to: string, mode: number): Promise<void> {
  await fs.chmod(from, mode);
  try {
    await fs.rename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  const beside = `${to}.psyche-new`;
  try {
    await fs.copyFile(from, beside);
    await fs.chmod(beside, mode);
    await fs.rename(beside, to);
  } catch (err) {
    await fs.rm(beside, { force: true });
    throw err;
  }
  await fs.rm(from, { force: true });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function canReplace(fs: ApplyFs, target: string): Promise<boolean> {
  try {
    await fs.access(dirname(target), fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// -- AppImage -------------------------------------------------------------------------------

const PREVIOUS_IMAGE = "Psyche.AppImage";

/** Copies the running image into `previousImageDir`, with `previous.json`. */
async function keepRunningImage(d: ApplyDeps, image: string): Promise<void> {
  const { fs, paths } = d;
  await fs.mkdir(paths.previousImageDir, { recursive: true, mode: 0o700 });
  const dest = join(paths.previousImageDir, PREVIOUS_IMAGE);
  const tmp = `${dest}.tmp`;
  await fs.copyFile(image, tmp);
  await fs.chmod(tmp, 0o755);
  await fs.rename(tmp, dest);
  const { sha256, bytes } = await fs.hash(dest);
  const record: ArtifactRecord = {
    version: d.current.version,
    ...(d.current.build ? { build: d.current.build } : {}),
    kind: "appimage",
    file: PREVIOUS_IMAGE,
    sha256,
    bytes,
    savedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(fs, join(paths.previousImageDir, RECORD_FILE), record);
}

export async function applyAppImage(
  staged: StagedUpdate,
  appImagePath: string,
  d: ApplyDeps,
): Promise<ApplyResult> {
  const bad = await verifyStaged(d.fs, staged);
  if (bad) return bad;
  if (!(await canReplace(d.fs, appImagePath))) {
    d.log(`${dirname(appImagePath)} is not writable: the update needs a manual download`);
    return { state: "manual", reason: "not_writable", file: staged.file };
  }
  try {
    await keepRunningImage(d, appImagePath);
  } catch (err) {
    // No way back would follow: do not start an update that cannot be undone.
    return fail("swap_failed", `could not keep the current image: ${errorText(err)}`);
  }
  await d.gateway.prepare();
  await d.gateway.stop();
  try {
    await replaceFile(d.fs, staged.file, appImagePath, 0o755);
  } catch (err) {
    await d.gateway.restart("update-failed").catch(() => undefined);
    return fail("swap_failed", errorText(err));
  }
  d.log(`replaced ${appImagePath} with ${staged.release}`);
  await d.gateway.restart("update");
  d.relaunch();
  return { state: "applied", release: staged.release };
}

// -- deb and rpm ----------------------------------------------------------------------------

/**
 * `pkexec` plus the package manager and its arguments, or undefined when the system has none.
 * rpm: `dnf` (Fedora, RHEL clones); openSUSE has no dnf, so `zypper` is the fallback (local
 * packages are unsigned: our own manifest checks the hash, so `--allow-unsigned-rpm`).
 */
export async function packageCommand(
  fs: ApplyFs,
  kind: "deb" | "rpm",
  file: string,
  mode: "install" | "downgrade",
): Promise<string[] | undefined> {
  if (kind === "deb") {
    return [
      PKEXEC,
      "/usr/bin/apt-get",
      "install",
      "--yes",
      ...(mode === "downgrade" ? ["--allow-downgrades"] : []),
      file,
    ];
  }
  if (await exists(fs, "/usr/bin/dnf")) {
    return [PKEXEC, "/usr/bin/dnf", mode === "downgrade" ? "downgrade" : "install", "--assumeyes", file];
  }
  if (await exists(fs, "/usr/bin/zypper")) {
    return [
      PKEXEC,
      "/usr/bin/zypper",
      "--non-interactive",
      "install",
      ...(mode === "downgrade" ? ["--oldpackage"] : []),
      "--allow-unsigned-rpm",
      file,
    ];
  }
  return undefined;
}

/** pkexec: 126 is "dismissed or not authorized"; 127 is "not authorized / could not run". */
const PKEXEC_DISMISSED = 126;

async function runPackageManager(
  d: ApplyDeps,
  cmd: string[],
): Promise<{ ok: true } | { ok: false; cancelled: boolean; detail: string }> {
  const [file, ...args] = cmd as [string, ...string[]];
  try {
    const res = await d.run(file, args);
    if (res.code === 0) return { ok: true };
    const tail = `${res.stderr}\n${res.stdout}`.trim().slice(-600);
    return {
      ok: false,
      cancelled: res.code === PKEXEC_DISMISSED,
      detail: tail || `${basename(cmd[1] ?? file)} exited ${res.code}`,
    };
  } catch (err) {
    return { ok: false, cancelled: false, detail: errorText(err) };
  }
}

/** After a successful install: the file we installed before becomes `previous`, this one `installed`. */
async function rotatePackages(d: ApplyDeps, staged: StagedUpdate, kind: "deb" | "rpm"): Promise<void> {
  const { fs, paths } = d;
  await fs.mkdir(paths.packageDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.previousPackageDir, { recursive: true, mode: 0o700 });
  const old = await readRecord(fs, join(paths.packageDir, INSTALLED_FILE));
  // Whatever `previous` held is two versions back now.
  const stale = await readRecord(fs, join(paths.previousPackageDir, RECORD_FILE));
  if (stale) await fs.rm(join(paths.previousPackageDir, stale.file), { force: true });
  await fs.rm(join(paths.previousPackageDir, RECORD_FILE), { force: true });
  if (old && (await exists(fs, join(paths.packageDir, old.file)))) {
    await fs.rename(join(paths.packageDir, old.file), join(paths.previousPackageDir, old.file));
    await writeJsonAtomic(fs, join(paths.previousPackageDir, RECORD_FILE), old);
  }
  const record: ArtifactRecord = {
    version: staged.release,
    kind,
    file: staged.artifact.name,
    sha256: staged.artifact.sha256,
    bytes: staged.artifact.bytes,
    savedAt: new Date().toISOString(),
  };
  await replaceFile(fs, staged.file, join(paths.packageDir, staged.artifact.name), 0o600);
  await writeJsonAtomic(fs, join(paths.packageDir, INSTALLED_FILE), record);
}

export async function applyPackage(
  staged: StagedUpdate,
  kind: "deb" | "rpm",
  d: ApplyDeps,
): Promise<ApplyResult> {
  const bad = await verifyStaged(d.fs, staged);
  if (bad) return bad;
  const cmd = await packageCommand(d.fs, kind, staged.file, "install");
  if (!cmd) return { state: "manual", reason: "no_package_manager", file: staged.file };
  await d.gateway.prepare();
  await d.gateway.stop();
  const res = await runPackageManager(d, cmd);
  if (!res.ok) {
    // Still the old version, so the old Gateway comes back.
    await d.gateway.restart("update-failed").catch(() => undefined);
    if (res.cancelled) return { state: "cancelled" };
    d.log(`package manager refused ${staged.artifact.name}: ${res.detail}`);
    return fail("package_manager_failed", res.detail);
  }
  try {
    await rotatePackages(d, staged, kind);
  } catch (err) {
    // The package is installed; only the rollback copy is lost. Say so, and carry on.
    d.log(`installed, but could not keep the package for rollback: ${errorText(err)}`);
  }
  d.log(`installed ${staged.artifact.name}`);
  await d.gateway.restart("update");
  d.relaunch();
  return { state: "applied", release: staged.release };
}

// -- rollback -------------------------------------------------------------------------------

/** What the caller owns: the Gateway's data snapshot and the "do not offer this build again" list. */
export interface RollbackHooks {
  /** Restore the pre-update snapshot of `~/.psyche` (Gateway stopped). */
  restoreSnapshot(): Promise<void>;
  /** `run/skip-builds.json`: the build being left, so the updater does not offer it again. */
  recordSkipBuild(build: { release: string; build?: string | undefined }): Promise<void>;
}

/** The version "Go back to …" would restore, or undefined when no previous artifact is kept. */
export async function previousArtifact(
  fs: ApplyFs,
  paths: LinuxUpdatePaths,
  kind: InstallKind,
): Promise<ArtifactRecord | undefined> {
  const dir = kind === "appimage" ? paths.previousImageDir : paths.previousPackageDir;
  const rec = await readRecord(fs, join(dir, RECORD_FILE));
  if (!rec || rec.kind !== kind) return undefined;
  return (await exists(fs, join(dir, rec.file))) ? rec : undefined;
}

export async function rollbackLinux(
  kind: InstallKind,
  appImagePath: string | undefined,
  d: ApplyDeps,
  hooks: RollbackHooks,
): Promise<ApplyResult> {
  const rec = await previousArtifact(d.fs, d.paths, kind);
  if (!rec) return fail("no_previous", "no previous version is kept");
  const dir = kind === "appimage" ? d.paths.previousImageDir : d.paths.previousPackageDir;
  const file = join(dir, rec.file);
  const { sha256, bytes } = await d.fs.hash(file);
  if (sha256 !== rec.sha256 || bytes !== rec.bytes) {
    return fail("hash_mismatch", `the kept copy of ${rec.version} has changed`);
  }
  const leaving = { release: d.current.version, build: d.current.build };
  await d.gateway.stop();
  if (kind === "appimage") {
    if (!appImagePath) return fail("swap_failed", "the AppImage path is unknown");
    if (!(await canReplace(d.fs, appImagePath))) {
      await d.gateway.restart("rollback-failed").catch(() => undefined);
      return { state: "manual", reason: "not_writable", file };
    }
    try {
      await replaceFile(d.fs, file, appImagePath, 0o755);
      await d.fs.rm(join(dir, RECORD_FILE), { force: true });
    } catch (err) {
      await d.gateway.restart("rollback-failed").catch(() => undefined);
      return fail("swap_failed", errorText(err));
    }
  } else {
    const cmd = await packageCommand(d.fs, kind, file, "downgrade");
    if (!cmd) {
      await d.gateway.restart("rollback-failed").catch(() => undefined);
      return { state: "manual", reason: "no_package_manager", file };
    }
    const res = await runPackageManager(d, cmd);
    if (!res.ok) {
      await d.gateway.restart("rollback-failed").catch(() => undefined);
      if (res.cancelled) return { state: "cancelled" };
      return fail("package_manager_failed", res.detail);
    }
    // The kept package is installed again: it is `installed`, and nothing older is kept.
    await d.fs.mkdir(d.paths.packageDir, { recursive: true, mode: 0o700 });
    const current = await readRecord(d.fs, join(d.paths.packageDir, INSTALLED_FILE));
    if (current) await d.fs.rm(join(d.paths.packageDir, current.file), { force: true });
    await replaceFile(d.fs, file, join(d.paths.packageDir, rec.file), 0o600).catch(() => undefined);
    await writeJsonAtomic(d.fs, join(d.paths.packageDir, INSTALLED_FILE), rec).catch(() => undefined);
    await d.fs.rm(join(dir, RECORD_FILE), { force: true });
  }
  try {
    await hooks.restoreSnapshot();
    await hooks.recordSkipBuild(leaving);
  } catch (err) {
    d.log(`rolled the app back, but the data restore did not finish: ${errorText(err)}`);
    await d.gateway.restart("rollback").catch(() => undefined);
    return fail("swap_failed", errorText(err));
  }
  d.log(`went back to ${rec.version}`);
  await d.gateway.restart("rollback");
  d.relaunch();
  return { state: "applied", release: rec.version };
}

/** Picks the apply routine for an install kind. */
export function applyLinuxUpdate(
  staged: StagedUpdate,
  install: { kind: InstallKind; appImagePath?: string },
  d: ApplyDeps,
): Promise<ApplyResult> {
  if (install.kind === "appimage") {
    if (!install.appImagePath) {
      return Promise.resolve(fail("swap_failed", "the AppImage path is unknown"));
    }
    return applyAppImage(staged, install.appImagePath, d);
  }
  return applyPackage(staged, install.kind, d);
}

import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LINUX_PACKAGE_ROOT } from "../platform/install-kind.ts";
import {
  artifactsFor,
  compareVersions,
  type InstallKind,
  type ManifestArtifact,
  type ReleaseKey,
  verifyManifest,
} from "../main/update-manifest.ts";
import type { UpdateGateway } from "./linux-gateway.ts";
import type { LinuxUpdatePaths, RunCommand } from "./linux-install.ts";

/**
 * The Linux apply step (docs/design/linux-desktop-2026.md §3.3, §3.4): what happens after the
 * updater has downloaded an artifact and checked it against the signed manifest.
 *
 * - AppImage: copy the running image aside, stop the Gateway, `rename()` the new image over
 *   `$APPIMAGE` (atomic on one filesystem; a copy beside the target and a rename otherwise), start
 *   the Gateway, relaunch. The old inode stays mounted for processes still using it. The target must
 *   be a regular file the user owns. If the new image carries a different `chrome-sandbox` than the
 *   setuid copy `--setup-system` installed, that is refreshed first (one admin prompt) or the update
 *   is not applied: the app is never left unstartable on Ubuntu 23.10+.
 * - deb and rpm: `pkexec /usr/lib/psyche/resources/psyche-system-setup install-package <sha256>
 *   <file>`. That script is root-owned in a packaged install. As root it copies the file into a
 *   root-only folder, hashes the copy, and installs only the copy, so nothing a same-user process
 *   does to the downloaded file after the check can reach root. The sha256 comes from the signed
 *   manifest. (A same-user process could still ask `pkexec` for an install of its own; that needs
 *   the admin password, which is the boundary.)
 *
 * Rollback keeps the artifact that was running together with the SIGNED manifest and signature
 * that vouch for it, and the manifest of the release it came from (for `minimumVersion`). Everything
 * the rollback trusts (version, file name, hash, size, the minimum) is taken from those two
 * manifests after checking their signatures with the embedded release keys; the files next to them
 * are user-writable and are believed for nothing. The data snapshot restore and the skip-list entry
 * are supplied by the caller.
 *
 * Everything is injected (fs, process runner, Gateway, relaunch, keys), so the tests run on any OS
 * with a fake `pkexec`. Downloaded files are re-hashed right before they are used.
 */

/** A manifest exactly as it was fetched and signed. */
export interface SignedManifest {
  bytes: Uint8Array;
  /** The `.sig` file's text. */
  sig: string;
}

/** What the updater leaves behind for the apply step. */
export interface StagedUpdate {
  release: string;
  /** The downloaded file, in `updatesDir`. */
  file: string;
  artifact: ManifestArtifact;
  /** The signed manifest that offered it (kept for rollback's `minimumVersion` check). */
  manifest: SignedManifest;
}

/** The running copy, for the skip-list entry. */
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
  | "no_previous"
  | "not_regular_file"
  | "sandbox_setup"
  | "bad_manifest"
  | "below_minimum"
  | "not_older";

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
  writeFile(path: string, data: string | Uint8Array, opts: { mode: number }): Promise<void>;
  readFile(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Rejects when the access is not allowed or the path does not exist. */
  access(path: string, mode: number): Promise<void>;
  /** `lstat`: a link is a link, not its target. */
  lstat(path: string): Promise<{ isFile: boolean; uid: number }>;
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
  readBytes: async (p) => new Uint8Array(await readFile(p)),
  access: (p, m) => access(p, m),
  lstat: async (p) => {
    const st = await lstat(p);
    return { isFile: st.isFile(), uid: st.uid };
  },
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
        .on("end", () => resolve({ sha256: h.digest("hex"), bytes })),
    }),
};

/** Keeps the app's setuid `chrome-sandbox` copy in step with the image being installed. */
export interface SandboxRefresh {
  /** Where `--setup-system` puts the setuid copy. */
  systemCopy: string;
  /** SHA-256 of the `chrome-sandbox` inside `image`, or undefined when it cannot be read. */
  newImageSandbox(image: string): Promise<string | undefined>;
  /** Runs the new image's `--setup-system` (one admin prompt). */
  setup(image: string): Promise<"ok" | "cancelled" | "failed">;
}

export interface ApplyDeps {
  fs: ApplyFs;
  run: RunCommand;
  gateway: UpdateGateway;
  /** Relaunch the desktop from the (new) install and quit this process. */
  relaunch(): void;
  paths: LinuxUpdatePaths;
  current: RunningBuild;
  log(message: string): void;
  /** The embedded release keys: rollback re-verifies the kept manifests with them. */
  keys: readonly ReleaseKey[];
  /** `x64` or `arm64`. */
  arch: string;
  /** This process's user id: an AppImage is replaced only when this user owns it. */
  uid: number;
  /**
   * The signed manifest of a release, from the pinned release host. Used once, to be able to keep
   * the running copy: without a manifest that vouches for it, no rollback to it is offered.
   */
  fetchManifest?(version: string): Promise<SignedManifest | undefined>;
  /** AppImage on Ubuntu 23.10+: see {@link SandboxRefresh}. */
  sandbox?: SandboxRefresh;
}

/** `$XDG_CACHE_HOME`-side name of the root-owned installer in a packaged install. */
export const PACKAGED_SETUP = `${LINUX_PACKAGE_ROOT}/resources/psyche-system-setup`;
/** Where `--setup-system` puts the AppImage's setuid sandbox. */
export const SYSTEM_SANDBOX = "/usr/local/lib/psyche/chrome-sandbox";

const PKEXEC = "/usr/bin/pkexec";
const PREVIOUS_IMAGE = "Psyche.AppImage";
/** The signed manifest (and `.sig`) of the kept release: where its version, name and hash come from. */
const KEPT_MANIFEST = "release-manifest.json";
/** The signed manifest of the release that replaced it: where `minimumVersion` comes from. */
const LEAVING_MANIFEST = "leaving-manifest.json";
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

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

async function writeAtomic(
  fs: ApplyFs,
  file: string,
  data: string | Uint8Array,
): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function writeManifest(
  fs: ApplyFs,
  dir: string,
  name: string,
  m: SignedManifest,
): Promise<void> {
  await writeAtomic(fs, join(dir, name), m.bytes);
  await writeAtomic(fs, join(dir, `${name}.sig`), m.sig);
}

async function readManifest(
  fs: ApplyFs,
  dir: string,
  name: string,
): Promise<SignedManifest | undefined> {
  try {
    return { bytes: await fs.readBytes(join(dir, name)), sig: await fs.readFile(join(dir, `${name}.sig`)) };
  } catch {
    return undefined;
  }
}

async function removeManifest(fs: ApplyFs, dir: string, name: string): Promise<void> {
  await fs.rm(join(dir, name), { force: true });
  await fs.rm(join(dir, `${name}.sig`), { force: true });
}

/** The manifest's signature and shape, then this arch and kind's entry. Throws on any failure. */
function trustedEntry(
  m: SignedManifest,
  keys: readonly ReleaseKey[],
  kind: InstallKind,
  arch: string,
): { release: string; minimumVersion: string; artifact: ManifestArtifact } {
  const manifest = verifyManifest(m.bytes, m.sig, keys);
  const artifact = artifactsFor(manifest, "linux", arch).find((a) => a.kind === kind);
  if (!artifact || !SAFE_NAME.test(artifact.name)) {
    throw new Error(`release ${manifest.release} lists no ${kind} for linux-${arch}`);
  }
  return { release: manifest.release, minimumVersion: manifest.minimumVersion, artifact };
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

// -- what is kept for rollback --------------------------------------------------------------

export interface KeptArtifact {
  /** From the signed manifest, never from a file next to it. */
  version: string;
  file: string;
  artifact: ManifestArtifact;
  /** `minimumVersion` of the release that replaced it. */
  minimumVersion: string;
}

export type KeptResult = { ok: true; kept: KeptArtifact } | { ok: false; code: ApplyFailure; detail: string };

/**
 * The kept artifact in `dir`, believed only as far as the signatures go: both manifests must
 * verify with `keys`, the file must be the one the first of them names (name, size, SHA-256).
 */
async function loadKept(
  fs: ApplyFs,
  dir: string,
  kind: InstallKind,
  trust: { keys: readonly ReleaseKey[]; arch: string },
): Promise<KeptResult> {
  const kept = await readManifest(fs, dir, KEPT_MANIFEST);
  const leaving = await readManifest(fs, dir, LEAVING_MANIFEST);
  if (!kept || !leaving) return { ok: false, code: "no_previous", detail: "no previous version is kept" };
  let entry: ReturnType<typeof trustedEntry>;
  let minimumVersion: string;
  try {
    entry = trustedEntry(kept, trust.keys, kind, trust.arch);
    minimumVersion = verifyManifest(leaving.bytes, leaving.sig, trust.keys).minimumVersion;
  } catch (err) {
    return { ok: false, code: "bad_manifest", detail: `the kept release is not vouched for: ${errorText(err)}` };
  }
  const file = join(dir, kind === "appimage" ? PREVIOUS_IMAGE : entry.artifact.name);
  if (!(await exists(fs, file))) {
    return { ok: false, code: "no_previous", detail: "the kept file is gone" };
  }
  const { sha256, bytes } = await fs.hash(file);
  if (sha256 !== entry.artifact.sha256 || bytes !== entry.artifact.bytes) {
    return {
      ok: false,
      code: "hash_mismatch",
      detail: `the kept copy of ${entry.release} does not match its signed manifest`,
    };
  }
  return { ok: true, kept: { version: entry.release, file, artifact: entry.artifact, minimumVersion } };
}

function keptDir(paths: LinuxUpdatePaths, kind: InstallKind): string {
  return kind === "appimage" ? paths.previousImageDir : paths.previousPackageDir;
}

/** The version "Go back to ..." would restore, or undefined when nothing verified is kept. */
export async function previousArtifact(
  fs: ApplyFs,
  paths: LinuxUpdatePaths,
  kind: InstallKind,
  trust: { keys: readonly ReleaseKey[]; arch: string },
): Promise<KeptArtifact | undefined> {
  const res = await loadKept(fs, keptDir(paths, kind), kind, trust);
  return res.ok ? res.kept : undefined;
}

async function clearKept(fs: ApplyFs, dir: string, extra: string[] = []): Promise<void> {
  await removeManifest(fs, dir, KEPT_MANIFEST);
  await removeManifest(fs, dir, LEAVING_MANIFEST);
  for (const f of extra) await fs.rm(join(dir, f), { force: true });
}

// -- AppImage -------------------------------------------------------------------------------

/**
 * Copies the running image into `previousImageDir`, next to the signed manifest of the running
 * release (fetched from the pinned release host) and the manifest that replaces it. Kept only when
 * that manifest verifies and the copy matches it byte for byte; otherwise nothing is kept and the
 * update goes on without a way back.
 */
async function keepRunningImage(d: ApplyDeps, image: string, leaving: SignedManifest): Promise<boolean> {
  const { fs, paths } = d;
  await fs.mkdir(paths.previousImageDir, { recursive: true, mode: 0o700 });
  await clearKept(fs, paths.previousImageDir, [PREVIOUS_IMAGE]);
  const running = await d.fetchManifest?.(d.current.version).catch(() => undefined);
  if (!running) {
    d.log(`no signed manifest for ${d.current.version}: not keeping it for rollback`);
    return false;
  }
  let entry: ReturnType<typeof trustedEntry>;
  try {
    entry = trustedEntry(running, d.keys, "appimage", d.arch);
  } catch (err) {
    d.log(`the manifest of ${d.current.version} does not verify (${errorText(err)}): not keeping it`);
    return false;
  }
  if (entry.release !== d.current.version) {
    d.log("the manifest names another release than the running one: not keeping it");
    return false;
  }
  const dest = join(paths.previousImageDir, PREVIOUS_IMAGE);
  const tmp = `${dest}.tmp`;
  await fs.copyFile(image, tmp);
  const { sha256, bytes } = await fs.hash(tmp);
  if (sha256 !== entry.artifact.sha256 || bytes !== entry.artifact.bytes) {
    await fs.rm(tmp, { force: true });
    d.log("the running image is not the released one (it was changed): not keeping it");
    return false;
  }
  await fs.chmod(tmp, 0o755);
  await fs.rename(tmp, dest);
  await writeManifest(fs, paths.previousImageDir, KEPT_MANIFEST, running);
  await writeManifest(fs, paths.previousImageDir, LEAVING_MANIFEST, leaving);
  return true;
}

/** The AppImage being replaced must be a regular file (not a link) that this user owns. */
async function replaceableImage(d: ApplyDeps, image: string): Promise<ApplyResult | undefined> {
  let st: { isFile: boolean; uid: number };
  try {
    st = await d.fs.lstat(image);
  } catch (err) {
    return fail("not_regular_file", `${image}: ${errorText(err)}`);
  }
  if (!st.isFile) return fail("not_regular_file", `${image} is not a regular file`);
  if (st.uid !== d.uid) return fail("not_regular_file", `${image} is not owned by this user`);
  return undefined;
}

/** Ubuntu 23.10+: a different `chrome-sandbox` in the new image must be installed first. */
async function refreshSandbox(d: ApplyDeps, image: string): Promise<ApplyResult | undefined> {
  const sb = d.sandbox;
  if (!sb || !(await exists(d.fs, sb.systemCopy))) return undefined;
  const installed = (await d.fs.hash(sb.systemCopy)).sha256;
  const fresh = await sb.newImageSandbox(image);
  if (!fresh) return fail("sandbox_setup", "could not read the new image's sandbox helper; not updating");
  if (fresh === installed) return undefined;
  d.log("the new image has a different sandbox helper: asking for the one-time setup first");
  const res = await sb.setup(image);
  if (res === "cancelled") return { state: "cancelled" };
  if (res === "failed") {
    return fail("sandbox_setup", "the sandbox helper could not be updated; the update was not applied");
  }
  return undefined;
}

export async function applyAppImage(
  staged: StagedUpdate,
  appImagePath: string,
  d: ApplyDeps,
): Promise<ApplyResult> {
  const bad = await verifyStaged(d.fs, staged);
  if (bad) return bad;
  const notFile = await replaceableImage(d, appImagePath);
  if (notFile) return notFile;
  if (!(await canReplace(d.fs, appImagePath))) {
    d.log(`${dirname(appImagePath)} is not writable: the update needs a manual download`);
    return { state: "manual", reason: "not_writable", file: staged.file };
  }
  const sandbox = await refreshSandbox(d, staged.file);
  if (sandbox) return sandbox;
  try {
    await keepRunningImage(d, appImagePath, staged.manifest);
  } catch (err) {
    // No way back would follow: do not start an update that cannot be undone.
    return fail("swap_failed", `could not keep the current image: ${errorText(err)}`);
  }
  await d.gateway.prepare();
  await d.gateway.stop();
  try {
    await replaceFile(d.fs, staged.file, appImagePath, 0o755);
  } catch (err) {
    await d.gateway.restart("update").catch(() => undefined);
    return fail("swap_failed", errorText(err));
  }
  d.log(`replaced ${appImagePath} with ${staged.release}`);
  await d.gateway.restart("update");
  d.relaunch();
  return { state: "applied", release: staged.release };
}

// -- deb and rpm ----------------------------------------------------------------------------

/**
 * `pkexec <setup> install-package [--downgrade] <sha256> <file>`. The setup script is the
 * root-owned one of the installed package; as root it copies the file, hashes the copy against
 * `sha256` and installs the copy with apt-get, dnf or zypper.
 */
export function installPackageCommand(
  sha256: string,
  file: string,
  mode: "install" | "downgrade",
): string[] {
  return [
    PKEXEC,
    PACKAGED_SETUP,
    "install-package",
    ...(mode === "downgrade" ? ["--downgrade"] : []),
    sha256,
    file,
  ];
}

/** pkexec: 126 is "dismissed or not authorized". The script: 65 hash mismatch, 69 no package manager. */
const PKEXEC_DISMISSED = 126;
const SETUP_HASH_MISMATCH = 65;
const SETUP_NO_PACKAGE_MANAGER = 69;

type PackageRun =
  | { ok: true }
  | { ok: false; cancelled: boolean; code: number; detail: string };

async function runPackageManager(d: ApplyDeps, cmd: string[]): Promise<PackageRun> {
  const [file, ...args] = cmd as [string, ...string[]];
  try {
    const res = await d.run(file, args);
    if (res.code === 0) return { ok: true };
    const tail = `${res.stderr}\n${res.stdout}`.trim().slice(-600);
    return {
      ok: false,
      cancelled: res.code === PKEXEC_DISMISSED,
      code: res.code,
      detail: tail || `${basename(cmd[1] ?? file)} exited ${res.code}`,
    };
  } catch (err) {
    return { ok: false, cancelled: false, code: -1, detail: errorText(err) };
  }
}

/** The failure to report for a refused package run, or undefined when it should be a retry/manual. */
function packageFailure(res: Extract<PackageRun, { ok: false }>, file: string): ApplyResult {
  if (res.cancelled) return { state: "cancelled" };
  if (res.code === SETUP_NO_PACKAGE_MANAGER) {
    return { state: "manual", reason: "no_package_manager", file };
  }
  if (res.code === SETUP_HASH_MISMATCH) return fail("hash_mismatch", res.detail);
  return fail("package_manager_failed", res.detail);
}

/**
 * After a successful install: the package we installed before becomes `previous` (with the
 * signed manifest that vouched for it), and this one becomes `installed`.
 */
async function rotatePackages(d: ApplyDeps, staged: StagedUpdate, kind: "deb" | "rpm"): Promise<void> {
  const { fs, paths } = d;
  await fs.mkdir(paths.packageDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.previousPackageDir, { recursive: true, mode: 0o700 });
  const old = await loadKept(fs, paths.packageDir, kind, { keys: d.keys, arch: d.arch }).catch(
    () => undefined,
  );
  // Whatever `previous` held is two versions back now.
  const stale = await loadKept(fs, paths.previousPackageDir, kind, { keys: d.keys, arch: d.arch });
  if (stale.ok) await fs.rm(stale.kept.file, { force: true });
  await clearKept(fs, paths.previousPackageDir);
  if (old?.ok) {
    await fs.rename(old.kept.file, join(paths.previousPackageDir, old.kept.artifact.name));
    const oldManifest = await readManifest(fs, paths.packageDir, KEPT_MANIFEST);
    if (oldManifest) await writeManifest(fs, paths.previousPackageDir, KEPT_MANIFEST, oldManifest);
    await writeManifest(fs, paths.previousPackageDir, LEAVING_MANIFEST, staged.manifest);
  }
  await removeManifest(fs, paths.packageDir, KEPT_MANIFEST);
  await removeManifest(fs, paths.packageDir, LEAVING_MANIFEST);
  await replaceFile(fs, staged.file, join(paths.packageDir, staged.artifact.name), 0o600);
  await writeManifest(fs, paths.packageDir, KEPT_MANIFEST, staged.manifest);
  // The "leaving" manifest of the installed package is its own: rollback to this one later reads
  // it as the kept manifest, and the release that replaces it supplies the minimum.
  await writeManifest(fs, paths.packageDir, LEAVING_MANIFEST, staged.manifest);
}

export async function applyPackage(
  staged: StagedUpdate,
  kind: "deb" | "rpm",
  d: ApplyDeps,
): Promise<ApplyResult> {
  const bad = await verifyStaged(d.fs, staged);
  if (bad) return bad;
  if (!(await exists(d.fs, PACKAGED_SETUP))) {
    return { state: "manual", reason: "no_package_manager", file: staged.file };
  }
  await d.gateway.prepare();
  await d.gateway.stop();
  const res = await runPackageManager(
    d,
    installPackageCommand(staged.artifact.sha256, staged.file, "install"),
  );
  if (!res.ok) {
    // Still the old version, so the old Gateway comes back.
    await d.gateway.restart("update").catch(() => undefined);
    d.log(`package manager refused ${staged.artifact.name}: ${res.detail}`);
    return packageFailure(res, staged.file);
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
  /** Restore the pre-update snapshot of `~/.psyche` taken when updating from `toVersion` (Gateway stopped). */
  restoreSnapshot(toVersion: string): Promise<void>;
  /** `run/skip-builds.json`: the build being left, so the updater does not offer it again. */
  recordSkipBuild(build: { release: string; build?: string | undefined }): Promise<void>;
}

export async function rollbackLinux(
  kind: InstallKind,
  appImagePath: string | undefined,
  d: ApplyDeps,
  hooks: RollbackHooks,
): Promise<ApplyResult> {
  const dir = keptDir(d.paths, kind);
  const loaded = await loadKept(d.fs, dir, kind, { keys: d.keys, arch: d.arch });
  if (!loaded.ok) return fail(loaded.code, loaded.detail);
  const { kept } = loaded;
  if (compareVersions(kept.version, d.current.version) >= 0) {
    return fail("not_older", `${kept.version} is not older than ${d.current.version}`);
  }
  if (compareVersions(kept.version, kept.minimumVersion) < 0) {
    return fail(
      "below_minimum",
      `${kept.version} is below the minimum version (${kept.minimumVersion}) the next release requires`,
    );
  }
  const file = kept.file;
  const leaving = { release: d.current.version, build: d.current.build };
  await d.gateway.stop();
  // The data goes back first, with the running app's own tools: after a package downgrade the
  // files under /usr/lib/psyche are the old version's, which have no restore command. If the swap
  // then fails, the newer app starts on older data and migrates it again, as after any restore.
  try {
    await hooks.restoreSnapshot(kept.version);
  } catch (err) {
    await d.gateway.restart("update").catch(() => undefined);
    return fail("swap_failed", `your data could not be put back: ${errorText(err)}`);
  }
  if (kind === "appimage") {
    if (!appImagePath) return fail("swap_failed", "the AppImage path is unknown");
    const notFile = await replaceableImage(d, appImagePath);
    if (notFile) {
      await d.gateway.restart("update").catch(() => undefined);
      return notFile;
    }
    if (!(await canReplace(d.fs, appImagePath))) {
      await d.gateway.restart("update").catch(() => undefined);
      return { state: "manual", reason: "not_writable", file };
    }
    try {
      await replaceFile(d.fs, file, appImagePath, 0o755);
      await clearKept(d.fs, dir);
    } catch (err) {
      await d.gateway.restart("update").catch(() => undefined);
      return fail("swap_failed", errorText(err));
    }
  } else {
    if (!(await exists(d.fs, PACKAGED_SETUP))) {
      await d.gateway.restart("update").catch(() => undefined);
      return { state: "manual", reason: "no_package_manager", file };
    }
    const res = await runPackageManager(
      d,
      installPackageCommand(kept.artifact.sha256, file, "downgrade"),
    );
    if (!res.ok) {
      await d.gateway.restart("update").catch(() => undefined);
      return packageFailure(res, file);
    }
    // The kept package is installed again: it is `installed`, and nothing older is kept.
    await d.fs.mkdir(d.paths.packageDir, { recursive: true, mode: 0o700 });
    const current = await loadKept(d.fs, d.paths.packageDir, kind, { keys: d.keys, arch: d.arch });
    if (current.ok) await d.fs.rm(current.kept.file, { force: true });
    const keptManifest = await readManifest(d.fs, dir, KEPT_MANIFEST);
    await replaceFile(d.fs, file, join(d.paths.packageDir, kept.artifact.name), 0o600).catch(
      () => undefined,
    );
    if (keptManifest) {
      await writeManifest(d.fs, d.paths.packageDir, KEPT_MANIFEST, keptManifest).catch(() => undefined);
      await writeManifest(d.fs, d.paths.packageDir, LEAVING_MANIFEST, keptManifest).catch(
        () => undefined,
      );
    }
    await clearKept(d.fs, dir);
  }
  await hooks.recordSkipBuild(leaving).catch((err: unknown) => {
    d.log(`rolled back, but could not note the skipped build: ${errorText(err)}`);
  });
  d.log(`went back to ${kept.version}`);
  await d.gateway.restart("build_mismatch");
  d.relaunch();
  return { state: "applied", release: kept.version };
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

// -- the real sandbox refresh ---------------------------------------------------------------

/**
 * The AppImage's own `--appimage-extract` pulls `chrome-sandbox` out of the new image (it runs
 * the verified image, as the user), and the image's own `--setup-system` does the admin step.
 */
export function createSandboxRefresh(run: RunCommand, systemCopy = SYSTEM_SANDBOX): SandboxRefresh {
  return {
    systemCopy,
    async newImageSandbox(image) {
      const work = await mkdtemp(join(tmpdir(), "psyche-sandbox-"));
      try {
        await chmod(image, 0o700);
        const res = await run("/usr/bin/env", [
          "-C",
          work,
          image,
          "--appimage-extract",
          "usr/lib/psyche/chrome-sandbox",
        ]);
        if (res.code !== 0) return undefined;
        return (await nodeApplyFs.hash(join(work, "squashfs-root", "usr/lib/psyche/chrome-sandbox")))
          .sha256;
      } catch {
        return undefined;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    async setup(image) {
      try {
        const res = await run(image, ["--setup-system"]);
        if (res.code === 0) return "ok";
        return res.code === PKEXEC_DISMISSED ? "cancelled" : "failed";
      } catch {
        return "failed";
      }
    },
  };
}

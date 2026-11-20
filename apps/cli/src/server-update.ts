import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { CliError } from "./errors.ts";
import type { Exec, ExecResult } from "./exec.ts";

/**
 * `psyche update` for a psyche-server install (docs/design/linux-helper-only-2026.md §3.2; wave
 * B1). The release manifest is the desktop's: Ed25519-signed `update-manifest.json`, whose
 * `platforms["linux-<arch>"]` lists `server-deb`, `server-rpm` and `server-tar-zst` files.
 *
 * What is trusted: only the keys the install itself ships (`release-keys.json` beside
 * `psyche-server.json`, root-owned for deb and rpm), the exact bytes those keys signed, and the
 * SHA-256 and size the signed manifest gives a file. Where the manifest or a file came from (the
 * network, `--from <dir>`) adds nothing. A release that is not newer than the running one is
 * refused, so an old signed manifest cannot walk an install back.
 *
 * deb and rpm are root's: the update is downloaded and verified, the pre-update snapshot is taken,
 * and one `sudo` command is printed for the owner to run (an owner decision: nothing here holds
 * root). That command copies the package into a root-owned folder and checks its signed SHA-256
 * as root before apt or dnf reads it, so a process of the account cannot swap the file in between.
 * The package's postinst restarts the Gateway and the headless helper on the new files.
 *
 * The tarball (an install under the owner's own account, deploy/linux-server/install.mjs) is
 * replaced in place: unpacked from the verified bytes in memory into `releases/<v>`, switched to
 * by renaming a symlink, started with the helper, and switched back if it does not come up
 * healthy. While the new Gateway says it is copying or migrating the data
 * (`run/update-progress.json`), the wait goes on, up to a ceiling; and the old build is only put
 * back when its own `migrate --check` says it can open the data as it is.
 *
 * Never as root: the tarball tree is the account's, and a root update would run code from it.
 *
 * The data folder is never written here except through `psyched snapshot`, which copies it into
 * `backups/pre-update` (apps/gateway/src/pre-update.ts, the Gateway's own snapshot code).
 */

export const PINNED_BASE = "https://github.com/devmello/psyche/releases/download/";
export const DEFAULT_MANIFEST_URL =
  "https://github.com/devmello/psyche/releases/latest/download/update-manifest.json";
export const INSTALL_FILE = "psyche-server.json";
export const KEYS_FILE = "release-keys.json";
export const GATEWAY_UNIT = "psyche-gateway.service";
/** The headless helper's user unit (deploy/systemd, wave B0). */
export const HEADLESS_UNIT = "psyche-helper-headless.service";
/** Where the printed `sudo` command puts a package before apt or dnf reads it: root's, 0700. */
export const ROOT_UPDATE_DIR = "/var/cache/psyche-server";
/** How long the Gateway's update progress note counts as fresh (the desktop's own value). */
export const UPDATE_PROGRESS_FRESH_MS = 5 * 60_000;
/** However long the snapshot and the migrations take, the wait for a new Gateway ends here. */
export const UPDATE_WAIT_CEILING_MS = 15 * 60_000;
/** `psyched snapshot`'s exit status when there is no data folder yet (gateway CLI_EXIT.noData). */
export const SNAPSHOT_NO_DATA = 5;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export type InstallKind = "deb" | "rpm" | "tarball";
export type ServerArch = "arm64" | "x64";

export interface ReleaseKey {
  keyId: string;
  publicKey: string;
}

export interface ServerInstall {
  kind: InstallKind;
  version: string;
  arch: ServerArch;
  /** The psyched bundle (psyched, psyche, runtime/node, app/). */
  bundle: string;
  /** Where psyche-server.json lives: /usr/lib/psyche-server, or releases/<v> of a tarball. */
  dir: string;
  /** Tarball only: the install root holding releases/, current and previous. */
  root?: string;
  keys: ReleaseKey[];
}

export interface ServerArtifact {
  name: string;
  kind: string;
  sha256: string;
  bytes: number;
}

export interface ServerManifest {
  release: string;
  baseUrl: string;
  platforms: Record<string, ServerArtifact[]>;
}

const fail = (message: string, details?: Record<string, unknown>) =>
  new CliError("failure", message, details);

/** semver precedence (as the desktop's update-manifest.ts): -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw fail(`not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === rb) return 0;
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i];
    const t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s);
    const nt = /^\d+$/.test(t);
    if (ns && nt && Number(s) !== Number(t)) return Math.sign(Number(s) - Number(t));
    if (ns !== nt) return ns ? -1 : 1;
    if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

export function keyIdOf(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every entry a `{ keyId, publicKey }` whose id is its key's, or this throws. */
export function parseKeys(text: string): ReleaseKey[] {
  const list: unknown = JSON.parse(text);
  if (!Array.isArray(list)) throw fail("release-keys.json is not a list");
  return list.map((k, i) => {
    if (
      !isObject(k) ||
      Object.keys(k).sort().join(",") !== "keyId,publicKey" ||
      typeof k.keyId !== "string" ||
      typeof k.publicKey !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(k.publicKey) ||
      keyIdOf(Buffer.from(k.publicKey, "base64")) !== k.keyId
    ) {
      throw fail(`release-keys.json: entry ${i} is not a valid release key`);
    }
    return { keyId: k.keyId, publicKey: k.publicKey };
  });
}

/** The bundle this CLI runs from: `<bundle>/app/apps/cli/dist/main.mjs`. */
export function bundleOfThisCli(script = process.argv[1]): string | undefined {
  if (script === undefined) return undefined;
  try {
    const real = realpathSync(script);
    const bundle = resolve(dirname(real), "../../../..");
    return existsSync(join(bundle, "build-info.json")) ? bundle : undefined;
  } catch {
    return undefined;
  }
}

/** What install `bundle` belongs to, from the files the package or the tarball put beside it. */
export function findServerInstall(bundle: string): ServerInstall {
  const real = realpathSync(bundle);
  const dir = dirname(real);
  let info: unknown;
  try {
    info = JSON.parse(readFileSync(join(dir, INSTALL_FILE), "utf8"));
  } catch {
    throw fail(
      "This psyche is not part of a psyche-server install, so it cannot update itself. Update the desktop app from its menu, the Docker image with docker compose pull, or a checkout with git pull.",
    );
  }
  if (
    !isObject(info) ||
    info.format !== "psyche-server-install" ||
    !["deb", "rpm", "tarball"].includes(info.kind as string) ||
    typeof info.version !== "string" ||
    !SEMVER.test(info.version) ||
    !["arm64", "x64"].includes(info.arch as string)
  ) {
    throw fail(`${join(dir, INSTALL_FILE)} is not a psyche-server install description`);
  }
  const keys = parseKeys(readFileSync(join(dir, KEYS_FILE), "utf8"));
  if (keys.length === 0) throw fail(`${join(dir, KEYS_FILE)} trusts no key`);
  const kind = info.kind as InstallKind;
  let root: string | undefined;
  if (kind === "tarball") {
    if (basename(dirname(dir)) !== "releases" || basename(dir) !== info.version)
      throw fail(`${dir} is not inside a psyche-server releases folder`);
    root = dirname(dirname(dir));
  }
  return {
    kind,
    version: info.version,
    arch: info.arch as ServerArch,
    bundle: real,
    dir,
    ...(root === undefined ? {} : { root }),
    keys,
  };
}

/** What `psyche status` says about a psyche-server install: its kind, version, and helper. */
export interface ServerInstallStatus {
  kind: InstallKind;
  version: string;
  /** The tarball's helper is the account's own file, so the Gateway cannot verify it. */
  helper?: "not_verified_tarball";
}

/** The psyche-server install this CLI belongs to, for `psyche status`; undefined for any other. */
export function serverInstallStatus(bundle: string | undefined): ServerInstallStatus | undefined {
  if (bundle === undefined) return undefined;
  try {
    const i = findServerInstall(bundle);
    return {
      kind: i.kind,
      version: i.version,
      ...(i.kind === "tarball" ? { helper: "not_verified_tarball" as const } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The status line: `psyche-server tarball 1.5.0; helper not verified (tarball install)`. */
export function serverInstallText(s: ServerInstallStatus): string {
  return `psyche-server ${s.kind} ${s.version}${s.helper === "not_verified_tarball" ? "; helper not verified (tarball install)" : ""}`;
}

/** The signature, against the install's keys, then the shape of what `psyche update` reads. */
export function verifyServerManifest(
  bytes: Uint8Array,
  sigText: string | undefined,
  keys: readonly ReleaseKey[],
): ServerManifest {
  if (!sigText) throw fail("The update manifest has no signature: refused.");
  let env: unknown;
  try {
    env = JSON.parse(sigText);
  } catch {
    throw fail("The update manifest's signature is not readable: refused.");
  }
  if (
    !isObject(env) ||
    env.alg !== "ed25519" ||
    typeof env.keyId !== "string" ||
    typeof env.signature !== "string"
  )
    throw fail("The update manifest's signature is not an Ed25519 signature: refused.");
  const key = keys.find((k) => k.keyId === env.keyId);
  if (!key)
    throw fail(
      `The update manifest is signed by key ${env.keyId}, which this install does not trust: refused.`,
    );
  let ok = false;
  try {
    const pub = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(key.publicKey, "base64").toString("base64url"),
      },
      format: "jwk",
    });
    ok = verify(null, bytes, pub, Buffer.from(env.signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw fail("The update manifest's signature does not match: refused.");
  let m: unknown;
  try {
    m = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw fail("The signed update manifest is not JSON.");
  }
  if (
    !isObject(m) ||
    m.format !== "psyche-update-manifest" ||
    m.version !== 1 ||
    typeof m.release !== "string" ||
    !SEMVER.test(m.release) ||
    typeof m.baseUrl !== "string"
  )
    throw fail("The signed update manifest is not one psyche update can read.");
  const platforms: Record<string, ServerArtifact[]> = {};
  if (isObject(m.platforms)) {
    for (const [key, list] of Object.entries(m.platforms)) {
      if (!/^linux-(arm64|x64)$/.test(key) || !Array.isArray(list)) continue;
      platforms[key] = list.filter(
        (a): a is ServerArtifact =>
          isObject(a) &&
          typeof a.name === "string" &&
          typeof a.kind === "string" &&
          typeof a.sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(a.sha256) &&
          typeof a.bytes === "number" &&
          Number.isSafeInteger(a.bytes) &&
          a.bytes > 0,
      );
    }
  }
  return { release: m.release, baseUrl: m.baseUrl, platforms };
}

export const EXTENSION: Record<InstallKind, string> = {
  deb: "deb",
  rpm: "rpm",
  tarball: "tar.zst",
};
const KIND: Record<InstallKind, string> = {
  deb: "server-deb",
  rpm: "server-rpm",
  tarball: "server-tar-zst",
};

/** `psyche-server-<release>-linux-<arch>.<ext>`, the only name an entry may have. */
export function artifactName(release: string, arch: ServerArch, kind: InstallKind): string {
  return `psyche-server-${release}-linux-${arch}.${EXTENSION[kind]}`;
}

/** True when `url` is under `pin` after URL normalization (as the desktop's isUnderPin). */
export function isUnderPin(candidate: string, pin: string): boolean {
  let c: URL;
  let p: URL;
  try {
    c = new URL(candidate);
    p = new URL(pin);
  } catch {
    return false;
  }
  if (c.username || c.password || c.search || c.hash) return false;
  if (c.origin !== p.origin || c.origin === "null") return false;
  const prefix = p.pathname.endsWith("/") ? p.pathname : `${p.pathname}/`;
  return c.pathname.startsWith(prefix) && !/%2f|%5c/i.test(c.pathname);
}

export type ServerPlan =
  | { action: "none"; reason: string; release: string }
  | { action: "update"; release: string; artifact: ServerArtifact; url: string };

/** What this install would update to from `m`: newer, its arch, its kind, exactly one file. */
export function planServerUpdate(
  m: ServerManifest,
  install: Pick<ServerInstall, "kind" | "arch" | "version">,
  pin: string | null = PINNED_BASE,
): ServerPlan {
  const order = compareVersions(m.release, install.version);
  if (order === 0) return { action: "none", reason: "up_to_date", release: m.release };
  if (order < 0) return { action: "none", reason: "older", release: m.release };
  const want = KIND[install.kind];
  const list = (m.platforms[`linux-${install.arch}`] ?? []).filter((a) => a.kind === want);
  if (list.length !== 1)
    return {
      action: "none",
      reason: list.length === 0 ? "no_artifact" : "ambiguous",
      release: m.release,
    };
  const artifact = list[0] as ServerArtifact;
  if (artifact.name !== artifactName(m.release, install.arch, install.kind))
    throw fail(`The signed manifest names ${artifact.name} for ${want}: refused.`);
  if (pin !== null && (!isUnderPin(m.baseUrl, pin) || !m.baseUrl.endsWith("/")))
    throw fail(`The update files are not under ${pin}: refused.`);
  return {
    action: "update",
    release: m.release,
    artifact,
    url: new URL(artifact.name, m.baseUrl).href,
  };
}

/** The size and SHA-256 the signed manifest gives, or this throws. */
export function verifyArtifactFile(file: string, artifact: ServerArtifact): void {
  verifyArtifactBytes(readFileSync(file), artifact);
}

/** The same, for bytes in memory: what was checked is what is used. */
export function verifyArtifactBytes(bytes: Buffer, artifact: ServerArtifact): void {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== artifact.bytes || hash !== artifact.sha256) {
    throw fail(
      `${artifact.name} does not match the signed manifest (${bytes.length} bytes, sha256 ${hash}): refused. Nothing was installed.`,
    );
  }
}

/** Where downloads go: `$XDG_CACHE_HOME/psyche/updates` (else `~/.cache/...`), 0700. */
export function updateCacheDir(env: NodeJS.ProcessEnv): string {
  const base =
    env.XDG_CACHE_HOME?.startsWith("/") === true
      ? env.XDG_CACHE_HOME
      : join(env.HOME ?? homedir(), ".cache");
  return join(base, "psyche", "updates");
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Runs `tar` with the decompressed bytes of a verified `.tar.zst` on its stdin. */
function tarFromBytes(args: string[], zst: Buffer, timeoutMs: number): Promise<ExecResult> {
  return new Promise((done) => {
    const child = spawn("tar", args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    // A decompression error fails the run even when tar has already exited.
    const fed = pipeline(Readable.from([zst]), createZstdDecompress(), child.stdin).then(
      () => undefined,
      (err: Error) => err.message,
    );
    child.on("error", (err) => done({ code: 127, stdout, stderr: stderr + err.message }));
    child.on("close", (code) => {
      void fed.then((why) =>
        done({ code: why === undefined ? (code ?? 1) : 1, stdout, stderr: why ?? stderr }),
      );
    });
  });
}

/**
 * Unpacks a verified `.tar.zst`, from the very bytes that were verified (in memory, through
 * tar's stdin: nothing is read back from disk), into `dest` (which must not exist). Node
 * decompresses (no zstd binary needed); tar unpacks. Every entry must sit under `<top>/` with no
 * `..` and no absolute path, even though the bytes are the signed ones.
 */
export async function unpackTarZst(
  zst: Buffer,
  dest: string,
  top: string,
  name = `${top}.tar.zst`,
): Promise<string> {
  const listed = await tarFromBytes(["-tf", "-"], zst, 120_000);
  if (listed.code !== 0) throw fail(`tar could not read ${name}: ${listed.stderr.trim()}`);
  for (const entry of listed.stdout.split("\n").filter(Boolean)) {
    if (
      entry.startsWith("/") ||
      entry.split("/").includes("..") ||
      (entry !== `${top}/` && !entry.startsWith(`${top}/`))
    )
      throw fail(`${name} holds ${entry}, outside ${top}/: refused.`);
  }
  mkdirSync(dest, { mode: 0o755 });
  const out = await tarFromBytes(["-xf", "-", "-C", dest, "--no-same-owner"], zst, 300_000);
  if (out.code !== 0) throw fail(`tar could not unpack ${name}: ${out.stderr.trim()}`);
  return join(dest, top);
}

/** A word for a POSIX shell, single-quoted unless it is plainly safe. */
export function shQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * The one command the owner runs to install a verified deb or rpm. As root it copies the package
 * out of the account's cache into `ROOT_UPDATE_DIR` (root's, 0700), checks the SHA-256 the signed
 * manifest gives on that copy, and only then lets apt or dnf read it, so the file the account
 * owns cannot be swapped between the check and the install. The cache path is shell-quoted.
 */
export function verifiedInstallCommand(
  kind: Exclude<InstallKind, "tarball">,
  file: string,
  artifact: Pick<ServerArtifact, "name" | "sha256">,
  downgrade = false,
): string {
  if (!/^psyche-server-[0-9A-Za-z.+-]+\.(deb|rpm)$/.test(artifact.name))
    throw fail(`not a psyche-server package name: ${artifact.name}`);
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw fail("not a SHA-256");
  const dest = `${ROOT_UPDATE_DIR}/${artifact.name}`;
  const tool =
    kind === "deb"
      ? `apt install ${downgrade ? "--allow-downgrades " : ""}${dest}`
      : `dnf ${downgrade ? "downgrade" : "install"} ${dest}`;
  const script = [
    "set -e",
    // The root copy goes however this ends: a hash that does not match, or apt refused.
    `trap "rm -f ${dest}" EXIT`,
    `install -d -m 0700 -o root -g root ${ROOT_UPDATE_DIR}`,
    `install -m 0600 -o root -g root "$1" ${dest}`,
    `echo "${artifact.sha256}  ${dest}" | sha256sum -c -`,
    tool,
  ].join("; ");
  return `sudo sh -c ${shQuote(script)} sh ${shQuote(file)}`;
}

/**
 * Keeps the signed manifest beside a downloaded package, so a later rollback can verify it again,
 * and the release that ran when it was downloaded (`from`): a rollback from it offers only that.
 */
export function keepManifest(file: string, bytes: Uint8Array, sig: string, from?: string): void {
  writeFileSync(`${file}.manifest.json`, bytes, { mode: 0o600 });
  writeFileSync(`${file}.manifest.json.sig`, sig, { mode: 0o600 });
  if (from !== undefined) writeFileSync(`${file}.from`, `${from}\n`, { mode: 0o600 });
}

const KEPT_SIDECARS = [".manifest.json", ".manifest.json.sig", ".from"];

/** Deletes kept packages of this kind and arch except the releases in `keep` (the last two). */
export function pruneKeptPackages(
  cacheDir: string,
  install: Pick<ServerInstall, "kind" | "arch">,
  keep: readonly string[],
): void {
  if (!existsSync(cacheDir)) return;
  const names = new Set(keep.map((r) => artifactName(r, install.arch, install.kind)));
  const ext = EXTENSION[install.kind].replace(".", "\\.");
  const own = new RegExp(`^psyche-server-.+-linux-${install.arch}\\.${ext}$`);
  for (const name of readdirSync(cacheDir)) {
    if (!own.test(name) || names.has(name)) continue;
    for (const suffix of ["", ...KEPT_SIDECARS])
      rmSync(join(cacheDir, `${name}${suffix}`), { force: true });
  }
}

export interface KeptPackage {
  file: string;
  release: string;
  artifact: ServerArtifact;
}

/**
 * The kept package of the release that ran before this one: the one the running release's own
 * kept package names as `from` when it was downloaded. Offered only when its kept manifest still
 * verifies against the install's keys and its bytes still match it; nothing else is offered, so a
 * planted older release is not a rollback target.
 */
export function findKeptPackage(
  cacheDir: string,
  install: Pick<ServerInstall, "kind" | "arch" | "version" | "keys">,
): KeptPackage | undefined {
  let release: string;
  try {
    const mine = join(cacheDir, artifactName(install.version, install.arch, install.kind));
    release = readFileSync(`${mine}.from`, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!SEMVER.test(release) || compareVersions(release, install.version) >= 0) return undefined;
  const name = artifactName(release, install.arch, install.kind);
  const file = join(cacheDir, name);
  try {
    const manifest = verifyServerManifest(
      readFileSync(`${file}.manifest.json`),
      readFileSync(`${file}.manifest.json.sig`, "utf8"),
      install.keys,
    );
    if (manifest.release !== release) return undefined;
    const artifact = (manifest.platforms[`linux-${install.arch}`] ?? []).find(
      (a) => a.kind === KIND[install.kind] && a.name === name,
    );
    if (artifact === undefined) return undefined;
    verifyArtifactFile(file, artifact);
    return { file, release, artifact };
  } catch {
    // A kept file that no longer verifies is not offered.
    return undefined;
  }
}

/** The pre-update snapshot folder for `from` → `to`, newest first, if the Gateway made one. */
export function snapshotFor(home: string, to: string): string | undefined {
  const dir = join(home, "backups", "pre-update");
  if (!existsSync(dir)) return undefined;
  // The Gateway's own folder name (pre-update.ts safeName): `<from>-to-<to>-<time>`. `<from>` is
  // the Gateway's own version, which need not be the package's, so only `<to>` is matched.
  const safe = (v: string) => v.replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 40) || "unknown";
  const marker = `-to-${safe(to)}-`;
  const timeOf = (n: string) => n.slice(n.lastIndexOf(marker) + marker.length);
  const names = readdirSync(dir)
    .filter((n) => !n.startsWith(".") && n.includes(marker))
    .filter((n) => existsSync(join(dir, n, "manifest.json")))
    .sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  const last = names.at(-1);
  return last === undefined ? undefined : join(dir, last);
}

/** The release `<root>/current` names, or undefined. */
function currentRelease(root: string): string | undefined {
  try {
    return basename(realpathSync(join(root, "current")));
  } catch {
    return undefined;
  }
}

/** The release folder an unpacked tarball goes to, after checking what it says it is. */
export function placeRelease(
  unpacked: string,
  root: string,
  release: string,
  arch: ServerArch,
): string {
  const info = JSON.parse(readFileSync(join(unpacked, INSTALL_FILE), "utf8")) as Record<
    string,
    unknown
  >;
  if (info.kind !== "tarball" || info.version !== release || info.arch !== arch)
    throw fail(
      `The unpacked update says ${String(info.kind)} ${String(info.version)} ${String(info.arch)}: refused.`,
    );
  const dest = join(root, "releases", release);
  // A leftover of an attempt that never became current (the release is newer than what runs).
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  renameSync(unpacked, dest);
  return dest;
}

// ── The command (`psyche update`, registered in commands/service.ts) ─────────────────────────

export interface ServerUpdateOptions {
  check?: boolean;
  rollback?: boolean;
  /** A folder holding update-manifest.json, its .sig and the package (offline, or a test). */
  from?: string;
  manifestUrl?: string;
  /**
   * How long the new Gateway gets to answer /healthz before a tarball update is undone, while it
   * reports no snapshot or migration in progress (then the wait goes on, to the ceiling).
   */
  healthyWithinMs?: number;
}

export interface UpdateDeps {
  stop(): Promise<void>;
  start(): Promise<void>;
  /** True once /healthz answers ok (false when it does not within `ms`). */
  healthy(ms: number): Promise<boolean>;
  /** True when the Gateway answers at all (it must be stopped for the snapshot). */
  running(): Promise<boolean>;
  exec: Exec;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** `$PSYCHE_HOME`. */
  home: string;
  log(line: string): void;
  /** This process's uid (`process.getuid()`), so root is refused. */
  uid?: number;
  now?: () => number;
  /** Tests: the longest wait for a new Gateway that reports progress (UPDATE_WAIT_CEILING_MS). */
  ceilingMs?: number;
}

export interface UpdateResult {
  data: Record<string, unknown>;
  human: string;
  exitCode?: number;
}

async function fetchBytes(f: typeof fetch, url: string): Promise<Buffer> {
  const res = await f(url, { redirect: "follow" });
  if (!res.ok) throw fail(`GET ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The signed manifest, from `--from <dir>` or the release page. */
async function loadManifest(
  o: ServerUpdateOptions,
  d: UpdateDeps,
): Promise<{ bytes: Buffer; sig: string; offline: boolean }> {
  if (o.from !== undefined) {
    const file = join(o.from, "update-manifest.json");
    if (!existsSync(file)) throw fail(`${file} does not exist`);
    const sig = existsSync(`${file}.sig`) ? readFileSync(`${file}.sig`, "utf8") : "";
    return { bytes: readFileSync(file), sig, offline: true };
  }
  const url = o.manifestUrl ?? DEFAULT_MANIFEST_URL;
  if (!url.startsWith("https://")) throw fail("--manifest-url must be an https URL");
  const bytes = await fetchBytes(d.fetch, url);
  const sig = await fetchBytes(d.fetch, `${url}.sig`).then(
    (b) => b.toString("utf8"),
    () => "",
  );
  return { bytes, sig, offline: false };
}

/**
 * `psyched snapshot <to>` of the running build, with the Gateway stopped: the folder, or
 * undefined when there is no data yet (nothing to copy).
 */
async function takeSnapshot(
  install: ServerInstall,
  to: string,
  d: UpdateDeps,
): Promise<string | undefined> {
  const r = await d.exec(join(install.bundle, "psyched"), ["snapshot", to], {
    env: { ...d.env, PSYCHE_HOME: d.home },
    timeoutMs: 30 * 60_000,
  });
  const lines = r.stdout.split("\n").filter(Boolean);
  if (r.code === SNAPSHOT_NO_DATA) return undefined;
  if (r.code !== 0) {
    throw fail(
      `The pre-update snapshot failed, so nothing was updated: ${(lines.at(-1) ?? r.stderr).trim()}`,
    );
  }
  return lines.at(-1) ?? "";
}

/** Runs a release's own install.mjs on that release's own Node. */
async function releaseScript(
  releaseDir: string,
  root: string,
  args: string[],
  d: UpdateDeps,
): Promise<void> {
  const r = await d.exec(
    join(releaseDir, "psyched", "runtime", "node"),
    [join(releaseDir, "install.mjs"), ...args, "--root", root],
    { env: d.env, timeoutMs: 120_000 },
  );
  if (r.code !== 0) throw fail(`install.mjs ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
}

/**
 * Restarts the headless helper when it runs, so it runs from the release now current (a helper
 * left on the replaced files is refused by the Gateway's peer check, or runs a deleted release).
 */
async function restartHelper(d: UpdateDeps): Promise<void> {
  await d.exec("systemctl", ["--user", "try-restart", HEADLESS_UNIT], { env: d.env });
}

/** True while the Gateway says it is copying or migrating the data (`run/update-progress.json`). */
export function updateInProgress(home: string, now: number = Date.now()): boolean {
  try {
    const note = JSON.parse(readFileSync(join(home, "run", "update-progress.json"), "utf8")) as {
      phase?: unknown;
      at?: unknown;
    };
    const at = typeof note.at === "string" ? Date.parse(note.at) : Number.NaN;
    return (
      (note.phase === "snapshot" || note.phase === "migrating") &&
      Number.isFinite(at) &&
      now - at < UPDATE_PROGRESS_FRESH_MS
    );
  } catch {
    return false;
  }
}

/**
 * Waits for /healthz: `ms`, and longer while the Gateway reports a snapshot or migrations in
 * progress, up to the ceiling (a big database can take minutes; the desktop waits the same way).
 */
export async function waitHealthyThroughUpdate(d: UpdateDeps, ms: number): Promise<boolean> {
  const now = d.now ?? Date.now;
  const started = now();
  const ceiling = d.ceilingMs ?? UPDATE_WAIT_CEILING_MS;
  let slice = ms;
  for (;;) {
    if (await d.healthy(slice)) return true;
    const spent = now() - started;
    if (spent >= ceiling || !updateInProgress(d.home, now())) return false;
    slice = Math.min(10_000, ceiling - spent);
  }
}

/** The build in `releaseDir` can open the data as it is now (its own `psyche migrate --check`). */
async function opensData(releaseDir: string, d: UpdateDeps): Promise<{ ok: boolean; why: string }> {
  const check = await d.exec(join(releaseDir, "psyched", "psyche"), ["migrate", "--check"], {
    env: { ...d.env, PSYCHE_HOME: d.home },
    timeoutMs: 120_000,
  });
  return { ok: check.code === 0, why: (check.stdout || check.stderr).trim() };
}

async function rollbackTarball(
  install: ServerInstall,
  d: UpdateDeps,
  o: ServerUpdateOptions,
): Promise<UpdateResult> {
  const root = install.root as string;
  let previous: string;
  try {
    previous = basename(realpathSync(join(root, "previous")));
  } catch {
    throw fail("There is no previous release to go back to.");
  }
  const prevDir = join(root, "releases", previous);
  // The older build must be able to open the data as it is now (a newer build may have migrated
  // it). Its own CLI says so; if it cannot, nothing changes and the snapshot from before is named.
  const check = await opensData(prevDir, d);
  if (!check.ok) {
    const snap = snapshotFor(d.home, install.version);
    return {
      data: { rollback: false, refused: "data_newer", previous, snapshot: snap ?? null },
      human: `${previous} cannot open your data as it is now:\n${check.why}\nNothing was changed.${snap ? ` Your data from before the update to ${install.version} is in ${snap}.` : ""}`,
      exitCode: 1,
    };
  }
  const wasRunning = await d.running();
  if (wasRunning) await d.stop();
  try {
    await releaseScript(prevDir, root, ["rollback"], d);
  } catch (err) {
    // install.mjs changed nothing (its links go back on any error): the release that ran, again.
    if (wasRunning) await d.start();
    throw err;
  }
  await d.exec("systemctl", ["--user", "daemon-reload"], { env: d.env });
  await d.start();
  await restartHelper(d);
  const healthy = await waitHealthyThroughUpdate(d, o.healthyWithinMs ?? 90_000);
  return {
    data: { rollback: true, from: install.version, to: previous, healthy },
    human: healthy
      ? `Back on ${previous} (was ${install.version}). Your data in ${d.home} was not changed.`
      : `Switched back to ${previous}, but the Gateway did not answer yet. Check psyche logs.`,
    exitCode: healthy ? 0 : 1,
  };
}

/** The restart a deb or rpm owner runs if the package could not restart Psyche itself. */
const RESTART_STEP = `  systemctl --user restart ${GATEWAY_UNIT} && systemctl --user try-restart ${HEADLESS_UNIT}`;

function rollbackPackage(install: ServerInstall, d: UpdateDeps): UpdateResult {
  const kind = install.kind as Exclude<InstallKind, "tarball">;
  const cache = updateCacheDir(d.env);
  const kept = findKeptPackage(cache, install);
  if (kept === undefined) {
    const tool =
      kind === "deb" ? "sudo apt install --allow-downgrades <file>" : "sudo dnf downgrade <file>";
    return {
      data: { rollback: false, refused: "no_kept_package" },
      human: `The package of the release that ran before ${install.version} is not kept in ${cache} (only one psyche update downloaded is kept, with the one before it). Download the release you want from ${PINNED_BASE}, check it against that release's SHA256SUMS, and install it with: ${tool}`,
      exitCode: 1,
    };
  }
  const snap = snapshotFor(d.home, install.version);
  const command = verifiedInstallCommand(kind, kept.file, kept.artifact, true);
  return {
    data: {
      rollback: "command",
      release: kept.release,
      file: kept.file,
      command,
      snapshot: snap ?? null,
    },
    human: [
      `Verified ${basename(kept.file)}, the release that ran before ${install.version}, again against its signed manifest. To go back to ${kept.release}, run this (it checks the file again as root first):`,
      `  ${command}`,
      `The package restarts Psyche; if it says it could not:`,
      RESTART_STEP,
      `If ${kept.release} says your data is from a newer version, ${snap ? `your data from before the update is in ${snap}` : "restore it from backups/pre-update"}.`,
    ].join("\n"),
  };
}

const NONE_TEXT: Record<string, (r: string, i: ServerInstall) => string> = {
  up_to_date: (_r, i) => `psyche-server ${i.version} is up to date.`,
  older: (r, i) =>
    `The newest release (${r}) is older than this one (${i.version}): nothing to do.`,
  no_artifact: (r, i) =>
    `Release ${r} has no psyche-server ${EXTENSION[i.kind]} for linux-${i.arch}.`,
  ambiguous: (r, i) =>
    `Release ${r} lists more than one psyche-server ${EXTENSION[i.kind]} for linux-${i.arch}: refused.`,
};

/**
 * `psyche update`: check, verify, snapshot, then install (tarball) or print the package command
 * (deb, rpm). `--rollback` goes back to the previous release.
 */
export async function serverUpdate(
  bundle: string | undefined,
  o: ServerUpdateOptions,
  d: UpdateDeps,
): Promise<UpdateResult> {
  if (bundle === undefined) {
    throw fail(
      "This psyche does not run from a psyche-server install, so it cannot update itself. Update the desktop app from its menu, the Docker image with docker compose pull, or a checkout with git pull.",
    );
  }
  if (d.uid === 0) {
    throw fail(
      "Do not run psyche update as root (sudo). Run it as the account Psyche runs for: it prints the one command that needs root.",
    );
  }
  const install = findServerInstall(bundle);
  if (o.rollback) {
    return install.kind === "tarball"
      ? rollbackTarball(install, d, o)
      : rollbackPackage(install, d);
  }

  const { bytes, sig, offline } = await loadManifest(o, d);
  const manifest = verifyServerManifest(bytes, sig, install.keys);
  const plan = planServerUpdate(manifest, install, offline ? null : PINNED_BASE);
  if (plan.action === "none") {
    return {
      data: { current: install.version, release: plan.release, update: false, reason: plan.reason },
      human: NONE_TEXT[plan.reason]?.(plan.release, install) ?? plan.reason,
      exitCode: plan.reason === "ambiguous" ? 1 : 0,
    };
  }
  if (o.check) {
    return {
      data: { current: install.version, release: plan.release, update: true, kind: install.kind },
      human: `psyche-server ${plan.release} is available (this is ${install.version}). Run psyche update to install it.`,
    };
  }

  // The file, verified against the signed manifest before anything else happens. The bytes that
  // were verified are the ones used: the tarball is unpacked from them, and a deb or rpm is
  // checked again as root by the printed command before apt or dnf reads it.
  const got = offline
    ? readFileSync(join(o.from as string, plan.artifact.name))
    : await fetchBytes(d.fetch, plan.url);
  verifyArtifactBytes(got, plan.artifact);
  let file: string | undefined;
  if (install.kind !== "tarball") {
    const cache = updateCacheDir(d.env);
    ensurePrivateDir(cache);
    file = join(cache, plan.artifact.name);
    const part = `${file}.part-${process.pid}`;
    try {
      writeFileSync(part, got, { mode: 0o600 });
      renameSync(part, file);
    } finally {
      rmSync(part, { force: true });
    }
    keepManifest(file, bytes, sig, install.version);
    pruneKeptPackages(cache, install, [plan.release, install.version]);
  }
  d.log(`verified ${plan.artifact.name} (sha256 ${plan.artifact.sha256})`);

  // The pre-update snapshot needs the Gateway stopped (it copies encrypted stores as bytes).
  const wasRunning = await d.running();
  if (wasRunning) await d.stop();
  let snapshot: string | undefined;
  try {
    snapshot = await takeSnapshot(install, plan.release, d);
  } catch (err) {
    if (wasRunning) await d.start();
    throw err;
  }
  d.log(
    snapshot === undefined ? "no data yet, nothing to copy" : `pre-update snapshot: ${snapshot}`,
  );
  const copied =
    snapshot === undefined
      ? "there is no data yet, so nothing needed copying"
      : `your data is copied to ${snapshot}`;

  if (install.kind !== "tarball") {
    if (wasRunning) await d.start();
    const cmd = verifiedInstallCommand(install.kind, file as string, plan.artifact);
    return {
      data: {
        current: install.version,
        release: plan.release,
        file,
        snapshot: snapshot ?? null,
        command: cmd,
      },
      human: [
        `psyche-server ${plan.release} is downloaded and verified, and ${copied}.`,
        "Install it with this command (it checks the file again as root before the package manager reads it):",
        `  ${cmd}`,
        "The package restarts the Gateway and the helper; if it says it could not:",
        RESTART_STEP,
      ].join("\n"),
    };
  }

  // Tarball: unpack beside the running release, switch, start, and switch back on failure.
  const root = install.root as string;
  const incoming = join(root, "releases", `.incoming-${plan.release}-${process.pid}`);
  rmSync(incoming, { recursive: true, force: true });
  let releaseDir: string;
  try {
    const top = plan.artifact.name.replace(/\.tar\.zst$/, "");
    const unpacked = await unpackTarZst(got, incoming, top, plan.artifact.name);
    releaseDir = placeRelease(unpacked, root, plan.release, install.arch);
    // install.mjs switches `current` last and puts it back on any error, so a refused activate
    // leaves the release that ran current; only that one is started again.
    await releaseScript(releaseDir, root, ["activate", plan.release], d);
  } catch (err) {
    if (currentRelease(root) !== install.version) {
      // Never start what a failed switch left behind.
      throw fail(
        `${(err as Error).message}\nThe switch to ${plan.release} did not finish and ${root}/current no longer names ${install.version}, so nothing was started. Run psyche update --rollback, or the old release's install.mjs rollback.`,
      );
    }
    if (wasRunning) await d.start();
    throw err;
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
  await d.exec("systemctl", ["--user", "daemon-reload"], { env: d.env });
  await d.start();
  await restartHelper(d);
  const ms = o.healthyWithinMs ?? 90_000;
  if (await waitHealthyThroughUpdate(d, ms)) {
    return {
      data: { from: install.version, to: plan.release, snapshot: snapshot ?? null, healthy: true },
      human: `Updated psyche-server ${install.version} → ${plan.release}. ${snapshot === undefined ? "There was no data to copy first." : `Your data was copied first to ${snapshot}.`} psyche update --rollback goes back.`,
    };
  }
  // Not healthy: back to the release that ran, but only when that build can open the data as it
  // is now (the new one may have migrated it). A migration that failed was already undone by the
  // new Gateway itself (pre-update.ts); the data is not touched here.
  await d.stop();
  const oldDir = join(root, "releases", install.version);
  const check = await opensData(oldDir, d);
  const saved = snapshot === undefined ? "" : ` Your data from before is in ${snapshot}.`;
  if (!check.ok) {
    // Going back would leave both down: the new release stays, and gets another start.
    await d.start();
    await restartHelper(d);
    return {
      data: {
        from: install.version,
        to: plan.release,
        snapshot: snapshot ?? null,
        healthy: false,
        rolledBack: false,
        refused: "data_newer",
      },
      human: `psyche-server ${plan.release} did not come up healthy, and ${install.version} cannot open your data as it is now (${check.why || "migrate --check refused"}), so ${plan.release} stays and was started again. Check psyche logs.${saved}`,
      exitCode: 1,
    };
  }
  await releaseScript(oldDir, root, ["rollback"], d);
  await d.exec("systemctl", ["--user", "daemon-reload"], { env: d.env });
  await d.start();
  await restartHelper(d);
  const back = await waitHealthyThroughUpdate(d, ms);
  return {
    data: {
      from: install.version,
      to: plan.release,
      snapshot: snapshot ?? null,
      healthy: false,
      rolledBack: true,
      backHealthy: back,
    },
    human: `psyche-server ${plan.release} did not come up healthy, so ${install.version} is back${back ? " and running" : ", but not answering yet (psyche logs)"}.${saved}`,
    exitCode: 1,
  };
}

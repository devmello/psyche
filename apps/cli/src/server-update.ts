import { createHash, createPublicKey, verify } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
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
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { CliError } from "./errors.ts";
import type { Exec } from "./exec.ts";

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
 * and the `apt`/`dnf` command to run is printed. The tarball (an install under the owner's own
 * account, deploy/linux-server/install.mjs) is replaced in place: unpacked into `releases/<v>`,
 * switched to by renaming a symlink, started, and switched back if it does not come up healthy.
 *
 * The data folder is never written here except through `psyched snapshot`, which copies it into
 * `backups/pre-update` (apps/gateway/src/pre-update.ts, the Gateway's own snapshot code).
 */

export const PINNED_BASE = "https://github.com/devmello/psyche/releases/download/";
export const DEFAULT_MANIFEST_URL =
  "https://github.com/devmello/psyche/releases/latest/download/update-manifest.json";
export const INSTALL_FILE = "psyche-server.json";
export const KEYS_FILE = "release-keys.json";
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
  const bytes = readFileSync(file);
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

/**
 * Unpacks a verified `.tar.zst` into `dest` (which must not exist). Node decompresses (no zstd
 * binary needed); tar unpacks. Every entry must sit under `<top>/` with no `..` and no absolute
 * path, even though the bytes are the signed ones.
 */
export async function unpackTarZst(
  file: string,
  dest: string,
  top: string,
  exec: Exec,
): Promise<string> {
  const tar = `${dest}.tar`;
  rmSync(tar, { force: true });
  await pipeline(
    createReadStream(file),
    createZstdDecompress(),
    createWriteStream(tar, { mode: 0o600 }),
  );
  try {
    const listed = await exec("tar", ["-tf", tar], { timeoutMs: 120_000 });
    if (listed.code !== 0)
      throw fail(`tar could not read ${basename(file)}: ${listed.stderr.trim()}`);
    for (const entry of listed.stdout.split("\n").filter(Boolean)) {
      if (
        entry.startsWith("/") ||
        entry.split("/").includes("..") ||
        (entry !== `${top}/` && !entry.startsWith(`${top}/`))
      )
        throw fail(`${basename(file)} holds ${entry}, outside ${top}/: refused.`);
    }
    mkdirSync(dest, { mode: 0o755 });
    const out = await exec("tar", ["-xf", tar, "-C", dest, "--no-same-owner"], {
      timeoutMs: 300_000,
    });
    if (out.code !== 0) throw fail(`tar could not unpack ${basename(file)}: ${out.stderr.trim()}`);
  } finally {
    rmSync(tar, { force: true });
  }
  return join(dest, top);
}

/** Keeps the signed manifest beside a downloaded package, so a later rollback can verify it again. */
export function keepManifest(file: string, bytes: Uint8Array, sig: string): void {
  writeFileSync(`${file}.manifest.json`, bytes, { mode: 0o600 });
  writeFileSync(`${file}.manifest.json.sig`, sig, { mode: 0o600 });
}

/**
 * The newest kept package older than `current` whose kept manifest still verifies against the
 * install's keys and whose bytes still match it. Nothing on disk is believed without that.
 */
export function findKeptPackage(
  cacheDir: string,
  install: Pick<ServerInstall, "kind" | "arch" | "version" | "keys">,
): { file: string; release: string } | undefined {
  if (!existsSync(cacheDir)) return undefined;
  const ext = EXTENSION[install.kind];
  const found: { file: string; release: string }[] = [];
  for (const name of readdirSync(cacheDir)) {
    const m = new RegExp(
      `^psyche-server-(.+)-linux-${install.arch}\\.${ext.replace(".", "\\.")}$`,
    ).exec(name);
    const release = m?.[1];
    if (release === undefined || !SEMVER.test(release)) continue;
    if (compareVersions(release, install.version) >= 0) continue;
    const file = join(cacheDir, name);
    try {
      const manifest = verifyServerManifest(
        readFileSync(`${file}.manifest.json`),
        readFileSync(`${file}.manifest.json.sig`, "utf8"),
        install.keys,
      );
      if (manifest.release !== release) continue;
      const entry = (manifest.platforms[`linux-${install.arch}`] ?? []).find(
        (a) => a.kind === KIND[install.kind] && a.name === name,
      );
      if (entry === undefined) continue;
      verifyArtifactFile(file, entry);
      found.push({ file, release });
    } catch {
      // A kept file that no longer verifies is not offered.
    }
  }
  return found.sort((a, b) => compareVersions(b.release, a.release))[0];
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
  /** How long the new Gateway gets to answer /healthz before a tarball update is undone. */
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

/** `psyched snapshot <to>` of the running build, with the Gateway stopped. */
async function takeSnapshot(install: ServerInstall, to: string, d: UpdateDeps): Promise<string> {
  const r = await d.exec(join(install.bundle, "psyched"), ["snapshot", to], {
    env: { ...d.env, PSYCHE_HOME: d.home },
    timeoutMs: 30 * 60_000,
  });
  const lines = r.stdout.split("\n").filter(Boolean);
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
  const check = await d.exec(join(prevDir, "psyched", "psyche"), ["migrate", "--check"], {
    env: { ...d.env, PSYCHE_HOME: d.home },
    timeoutMs: 120_000,
  });
  if (check.code !== 0) {
    const snap = snapshotFor(d.home, install.version);
    return {
      data: { rollback: false, refused: "data_newer", previous, snapshot: snap ?? null },
      human: `${previous} cannot open your data as it is now:\n${check.stdout.trim()}\nNothing was changed.${snap ? ` Your data from before the update to ${install.version} is in ${snap}.` : ""}`,
      exitCode: 1,
    };
  }
  const wasRunning = await d.running();
  if (wasRunning) await d.stop();
  await releaseScript(prevDir, root, ["rollback"], d);
  await d.exec("systemctl", ["--user", "daemon-reload"], { env: d.env });
  await d.start();
  const healthy = await d.healthy(o.healthyWithinMs ?? 90_000);
  return {
    data: { rollback: true, from: install.version, to: previous, healthy },
    human: healthy
      ? `Back on ${previous} (was ${install.version}). Your data in ${d.home} was not changed.`
      : `Switched back to ${previous}, but the Gateway did not answer yet. Check psyche logs.`,
    exitCode: healthy ? 0 : 1,
  };
}

function rollbackPackage(install: ServerInstall, d: UpdateDeps): UpdateResult {
  const cache = updateCacheDir(d.env);
  const kept = findKeptPackage(cache, install);
  const tool = (f: string) =>
    install.kind === "deb" ? `sudo apt install --allow-downgrades ${f}` : `sudo dnf downgrade ${f}`;
  if (kept === undefined) {
    return {
      data: { rollback: false, refused: "no_kept_package" },
      human: `No verified older psyche-server package is kept in ${cache}. Download the release you want from ${PINNED_BASE}, check it against that release's SHA256SUMS, and install it with: ${tool("<file>")}`,
      exitCode: 1,
    };
  }
  const snap = snapshotFor(d.home, install.version);
  return {
    data: { rollback: "command", release: kept.release, file: kept.file, snapshot: snap ?? null },
    human: [
      `Verified ${basename(kept.file)} again against its signed manifest. To go back to ${kept.release}:`,
      `  ${tool(kept.file)}`,
      "  systemctl --user restart psyche-gateway.service",
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

  // The file, verified against the signed manifest before anything else happens.
  const cache = updateCacheDir(d.env);
  ensurePrivateDir(cache);
  const file = join(cache, plan.artifact.name);
  const part = `${file}.part-${process.pid}`;
  try {
    const got = offline
      ? readFileSync(join(o.from as string, plan.artifact.name))
      : await fetchBytes(d.fetch, plan.url);
    writeFileSync(part, got, { mode: 0o600 });
    verifyArtifactFile(part, plan.artifact);
    renameSync(part, file);
  } finally {
    rmSync(part, { force: true });
  }
  keepManifest(file, bytes, sig);
  d.log(`verified ${plan.artifact.name} (sha256 ${plan.artifact.sha256})`);

  // The pre-update snapshot needs the Gateway stopped (it copies encrypted stores as bytes).
  const wasRunning = await d.running();
  if (wasRunning) await d.stop();
  let snapshot: string;
  try {
    snapshot = await takeSnapshot(install, plan.release, d);
  } catch (err) {
    if (wasRunning) await d.start();
    throw err;
  }
  d.log(`pre-update snapshot: ${snapshot}`);

  if (install.kind !== "tarball") {
    if (wasRunning) await d.start();
    const cmd = install.kind === "deb" ? `sudo apt install ${file}` : `sudo dnf install ${file}`;
    return {
      data: { current: install.version, release: plan.release, file, snapshot, command: cmd },
      human: [
        `psyche-server ${plan.release} is downloaded and verified, and your data is copied to ${snapshot}.`,
        "Install it, then restart the Gateway:",
        `  ${cmd}`,
        "  systemctl --user restart psyche-gateway.service",
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
    const unpacked = await unpackTarZst(file, incoming, top, d.exec);
    releaseDir = placeRelease(unpacked, root, plan.release, install.arch);
    await releaseScript(releaseDir, root, ["activate", plan.release], d);
  } catch (err) {
    if (wasRunning) await d.start();
    throw err;
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
  await d.exec("systemctl", ["--user", "daemon-reload"], { env: d.env });
  await d.start();
  if (await d.healthy(o.healthyWithinMs ?? 90_000)) {
    return {
      data: { from: install.version, to: plan.release, snapshot, healthy: true },
      human: `Updated psyche-server ${install.version} → ${plan.release}. Your data was copied first to ${snapshot}. psyche update --rollback goes back.`,
    };
  }
  // Not healthy: back to the release that ran. A migration that failed was already undone by the
  // new Gateway itself (pre-update.ts); the data is not touched here.
  await d.stop();
  await releaseScript(join(root, "releases", install.version), root, ["rollback"], d);
  await d.exec("systemctl", ["--user", "daemon-reload"], { env: d.env });
  await d.start();
  const back = await d.healthy(o.healthyWithinMs ?? 90_000);
  return {
    data: {
      from: install.version,
      to: plan.release,
      snapshot,
      healthy: false,
      rolledBack: true,
      backHealthy: back,
    },
    human: `psyche-server ${plan.release} did not come up healthy, so ${install.version} is back${back ? " and running" : ", but not answering yet (psyche logs)"}. Your data from before is in ${snapshot}.`,
    exitCode: 1,
  };
}
